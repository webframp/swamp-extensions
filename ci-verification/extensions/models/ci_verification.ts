// SPDX-License-Identifier: Apache-2.0
/**
 * Pre-PR verification for webframp/swamp-extensions as typed, versioned swamp
 * data.
 *
 * Every method takes the repository checkout and a commit, resolves the commit
 * once, and runs its commands in a throwaway worktree at that commit, so the
 * verified state is the committed state and the caller's checkout is never
 * touched. Results are keyed by the commit's tree hash; each check's log is
 * stored as swamp data beside its result.
 *
 * @module
 */

import { z } from "npm:zod@4.6.7";
import {
  BARE_SPECIFIER_COMMAND,
  judgeBareSpecifiers,
  judgeZodPins,
  ZOD_PIN_COMMAND,
} from "./_lib/ci_patterns.ts";
import { childEnv, run, type RunResult } from "./_lib/exec.ts";
import {
  changedFiles,
  checkRepoPath,
  isAncestor,
  resolveCommit,
  treeOf,
  withTempHome,
  withWorktree,
} from "./_lib/git.ts";
import { judgeQuality } from "./_lib/quality.ts";
import { postAttestation } from "./_lib/refstore.ts";
import { checkSlug, pool, selectionId, slug } from "./_lib/util.ts";

/** The per-extension tasks CI's extension-check job runs. */
export const EXTENSION_TASKS = ["check", "lint", "fmt:check", "test"] as const;

/**
 * Paths whose change alters what verification checks: the run uses the
 * commit's own copies, so a passing result needs a person's sign-off.
 */
export const TRUST_ROOT = [
  "scripts/ci-discover/",
  "scripts/check-reserved-names/",
  "ci-verification/",
  ".github/workflows/",
] as const;

/** What an attestation covers of CI, and what it does not. */
export const COVERAGE = {
  covered: [
    "extension-check: check, lint, fmt:check and test for each selected extension",
    "manifest-validate: swamp extension fmt --check for each selected extension, and the bare-specifier and zod-pin greps",
    "quality-gate: the registry quality rubric for each selected extension",
    "reserved-data-names",
    "scripts-check: the four tasks of each scripts/ tool the change touches",
  ],
  notCovered: [
    "manifest-validate: manifest fmt for extensions outside the selection",
    "scripts-check: scripts/ tools the change does not touch",
    "adversarial-review and ci-security-review (CI's agent reviews); the factory's own reviews are recorded under reviews",
    "CI runs on the merge of head into the current base; this ran on head",
  ],
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Status = z.enum(["passed", "failed"]);

const ToolsSchema = z.object({
  deno: z.string(),
  swamp: z.string(),
});

const SelectionSchema = z.object({
  commit: Sha,
  tree: Sha,
  base: Sha,
  baseIsAncestor: z.boolean(),
  scope: z.enum(["full", "scoped"]),
  reason: z.string(),
  selectionId: z.string(),
  extensions: z.array(z.object({ dir: z.string(), slug: z.string() })),
  repoChecks: z.array(z.string()),
  trustRootChanged: z.array(z.string()),
  modelVersion: z.string(),
  createdAt: z.string(),
});
type Selection = z.infer<typeof SelectionSchema>;

const TaskResultSchema = z.object({
  name: z.string(),
  status: Status,
  exitCode: z.number().nullable(),
  durationMs: z.number(),
});

/** Fields every recorded result carries, so it can be judged later. */
const ResultBase = {
  selectionId: z.string(),
  modelVersion: z.string(),
  tools: ToolsSchema,
  commit: Sha,
  tree: Sha,
  status: Status,
  log: z.string(),
  truncated: z.boolean(),
  finishedAt: z.string(),
};

const CheckSchema = z.object({
  ...ResultBase,
  extension: z.string(),
  results: z.array(TaskResultSchema),
});
type CheckRecord = z.infer<typeof CheckSchema>;

const QualitySchema = z.object({
  ...ResultBase,
  extension: z.string(),
  reason: z.string().optional(),
  percentage: z.number().optional(),
  provisionalPercentage: z.number().optional(),
  allPassed: z.boolean().optional(),
});
type QualityRecord = z.infer<typeof QualitySchema>;

const RepoCheckSchema = z.object({
  ...ResultBase,
  name: z.string(),
  exitCode: z.number().nullable(),
  reason: z.string().optional(),
});
type RepoCheckRecord = z.infer<typeof RepoCheckSchema>;

const ReviewSchema = z.object({
  name: z.string().min(1),
  verdict: z.enum(["pass", "fail"]),
  findings: z.record(z.string(), z.number()).optional(),
});

const ApprovalSchema = z.object({
  gateId: z.string().min(1),
  decision: z.string().min(1),
  by: z.string().optional(),
  at: z.string().optional(),
  note: z.string().optional(),
});

const AttestationSchema = z.object({
  version: z.literal(1),
  modelVersion: z.string(),
  tools: ToolsSchema,
  subject: z.object({
    commit: Sha,
    tree: Sha,
    base: Sha,
    baseIsAncestor: z.boolean(),
  }),
  discovery: z.object({
    scope: z.enum(["full", "scoped"]),
    reason: z.string(),
    selectionId: z.string(),
    extensions: z.array(z.string()),
  }),
  extensions: z.array(z.object({
    extension: z.string(),
    checks: z.array(TaskResultSchema),
    quality: z.object({
      percentage: z.number().optional(),
      provisionalPercentage: z.number().optional(),
    }),
  })),
  repoChecks: z.array(z.object({ name: z.string(), status: Status })),
  reviews: z.array(ReviewSchema),
  approvals: z.array(ApprovalSchema),
  reviewsAndApprovalsCallerAsserted: z.literal(true),
  coverage: z.object({
    covered: z.array(z.string()),
    notCovered: z.array(z.string()),
  }),
  trustRootChanged: z.array(z.string()),
  requiresSignOff: z.boolean(),
  gate: z.object({
    allPassed: z.literal(true),
    extensions: z.number(),
    checks: z.number(),
  }),
  generatedAt: z.string(),
});
type Attestation = z.infer<typeof AttestationSchema>;

const PostedSchema = z.object({
  ref: z.string(),
  refCommit: Sha,
  remote: z.string(),
  commit: Sha,
  tree: Sha,
  postedAt: z.string(),
});

const RepoArg = z.string().min(1).describe(
  "Absolute path to a swamp-extensions checkout that contains the commit",
);
const CommitArg = z.string().min(1).describe(
  "The commit to verify: a sha or anything git rev-parse resolves to one",
);
const ConcurrencyArg = z.number().int().min(1).max(16).default(4).describe(
  "Extensions verified at once",
);

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type Handle = { name: string };

type MethodContext = {
  writeResource: (
    spec: string,
    instance: string,
    data: Record<string, unknown>,
  ) => Promise<Handle>;
  readResource?: (
    instance: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  createFileWriter: (
    spec: string,
    instance: string,
  ) => { writeText: (text: string) => Promise<Handle> };
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Data names; one prefix per spec so names never collide across specs. */
export const names = {
  selection: (tree: string) => `selection-${tree}`,
  check: (tree: string, s: string) => `check-${tree}-${s}`,
  quality: (tree: string, s: string) => `quality-${tree}-${s}`,
  repoCheck: (tree: string, check: string) =>
    `repocheck-${tree}-${checkSlug(check)}`,
  attestation: (tree: string) => `attestation-${tree}`,
  posted: (tree: string) => `posted-${tree}`,
  log: (tree: string, kind: string, s: string) => `log-${tree}-${kind}-${s}`,
};

async function read(
  context: MethodContext,
  name: string,
): Promise<Record<string, unknown> | null> {
  if (!context.readResource) {
    throw new Error("this swamp does not provide readResource");
  }
  return await context.readResource(name);
}

interface Tools {
  deno: string;
  swamp: string;
  denoDir?: string;
}

async function firstLine(cmd: string, args: string[]): Promise<string> {
  const r = await run({
    cmd,
    args,
    cwd: Deno.cwd(),
    env: childEnv("swamp"),
  });
  return r.ok ? (r.stdout.split("\n")[0] ?? "").trim() : "unavailable";
}

/** Tool versions, which decide whether a stored result can be reused. */
async function toolInfo(): Promise<Tools> {
  const info = await run({
    cmd: "deno",
    args: ["info", "--json"],
    cwd: Deno.cwd(),
    env: childEnv("git"),
  });
  let denoDir: string | undefined;
  try {
    denoDir = JSON.parse(info.stdout).denoDir;
  } catch {
    denoDir = undefined;
  }
  return {
    deno: await firstLine("deno", ["--version"]),
    swamp: await firstLine("swamp", ["--version"]),
    denoDir,
  };
}

function sameTools(a: unknown, b: Tools): boolean {
  const t = a as { deno?: string; swamp?: string } | undefined;
  return t?.deno === b.deno && t?.swamp === b.swamp;
}

/**
 * A stored result is reused only when it passed for this selection, this model
 * version and these tools. A failed result is always run again.
 */
export function reusable(
  stored: Record<string, unknown> | null,
  sel: Selection,
  tools: Tools,
): boolean {
  return !!stored && stored.status === "passed" &&
    stored.selectionId === sel.selectionId &&
    stored.modelVersion === MODEL_VERSION && sameTools(stored.tools, tools);
}

async function resolveTarget(
  repoPath: string,
  commitArg: string,
  signal?: AbortSignal,
): Promise<{ sha: string; tree: string }> {
  await checkRepoPath(repoPath);
  const sha = await resolveCommit(repoPath, commitArg, signal);
  return { sha, tree: await treeOf(repoPath, sha, signal) };
}

async function loadSelection(
  context: MethodContext,
  tree: string,
  sha: string,
): Promise<Selection> {
  const stored = await read(context, names.selection(tree));
  if (!stored) {
    throw new Error(`no selection for tree ${tree}: run discover first`);
  }
  const sel = SelectionSchema.parse(stored);
  if (sel.commit !== sha) {
    throw new Error(
      `the selection for tree ${tree} is for commit ${sel.commit}, not ${sha}: run discover again`,
    );
  }
  return sel;
}

function taskEnv(home: string, tools: Tools) {
  return childEnv("task", { taskHome: home, denoDir: tools.denoDir });
}

function swampEnv(tools: Tools) {
  return childEnv("swamp", { denoDir: tools.denoDir });
}

function section(title: string, r: RunResult): string {
  return `===== ${title} (exit ${r.code ?? "did not start"}) =====\n${r.log}\n`;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Pre-PR verification of a swamp-extensions commit, recorded as swamp data. */
export const model = {
  type: "@webframp/ci-verification",
  version: "2026.11.12.1",
  globalArguments: z.object({}),

  resources: {
    selection: {
      description: "What the diff selects: extensions and repo-wide checks",
      schema: SelectionSchema,
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
    check: {
      description:
        "One extension's check, lint, fmt:check, test and manifest fmt",
      schema: CheckSchema,
      lifetime: "30d" as const,
      garbageCollection: 3,
    },
    quality: {
      description: "One extension's registry quality result",
      schema: QualitySchema,
      lifetime: "30d" as const,
      garbageCollection: 3,
    },
    repocheck: {
      description: "One repo-wide check",
      schema: RepoCheckSchema,
      lifetime: "30d" as const,
      garbageCollection: 3,
    },
    attestation: {
      description: "The attestation for a tree, built from recorded results",
      schema: AttestationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    posted: {
      description: "Where an attestation was posted",
      schema: PostedSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  files: {
    log: {
      description: "The output behind one recorded result, capped at 256 KiB",
      contentType: "text/plain",
      lifetime: "30d" as const,
      garbageCollection: 3,
    },
  },

  methods: {
    discover: {
      description:
        "Record which extensions and repo-wide checks the diff from base selects, using the commit's own scripts/ci-discover",
      arguments: z.object({
        repoPath: RepoArg,
        commit: CommitArg,
        base: z.string().min(1).describe("The base the diff is taken against"),
      }),
      execute: async (
        args: { repoPath: string; commit: string; base: string },
        context: MethodContext,
      ) => {
        const signal = context.signal;
        const { sha, tree } = await resolveTarget(
          args.repoPath,
          args.commit,
          signal,
        );
        const base = await resolveCommit(args.repoPath, args.base, signal);
        const tools = await toolInfo();
        const changed = await changedFiles(args.repoPath, base, sha, signal);

        const discovered = await withTempHome((home) =>
          withWorktree(args.repoPath, sha, signal, async (wt) => {
            const r = await run({
              cmd: "deno",
              args: ["task", "discover", "--", "--diff-base", base],
              cwd: `${wt}/scripts/ci-discover`,
              env: taskEnv(home, tools),
              signal,
            });
            if (!r.ok) {
              throw new Error(`ci-discover failed: ${r.log.trim()}`);
            }
            const tools_: string[] = [];
            for (
              const tool of new Set(
                changed.filter((f) => f.startsWith("scripts/"))
                  .map((f) => f.split("/")[1]),
              )
            ) {
              const cfg = await Deno.readTextFile(
                `${wt}/scripts/${tool}/deno.json`,
              ).catch(() => null);
              if (cfg && JSON.parse(cfg).tasks) tools_.push(tool);
            }
            return {
              out: JSON.parse(r.stdout) as {
                scope: "full" | "scoped";
                reason: string;
                extensions: string[];
              },
              scriptTools: tools_.sort(),
            };
          })
        );

        const repoChecks = [
          "reserved-data-names",
          "bare-import-specifiers",
          "zod-pin",
          ...discovered.scriptTools.flatMap((t) =>
            EXTENSION_TASKS.map((task) => `scripts/${t}:${task}`)
          ),
        ];
        const extensions = discovered.out.extensions.map((dir) => ({
          dir,
          slug: slug(dir),
        }));
        const selection: Selection = {
          commit: sha,
          tree,
          base,
          baseIsAncestor: await isAncestor(args.repoPath, base, sha, signal),
          scope: discovered.out.scope,
          reason: discovered.out.reason,
          selectionId: await selectionId({
            base,
            commit: sha,
            extensions: extensions.map((e) => e.dir),
            repoChecks,
          }),
          extensions,
          repoChecks,
          trustRootChanged: changed.filter((f) =>
            TRUST_ROOT.some((p) => f.startsWith(p))
          ),
          modelVersion: MODEL_VERSION,
          createdAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "selection",
          names.selection(tree),
          selection,
        );
        context.logger.info(
          "Selected {count} extension(s), scope {scope}, for tree {tree}",
          { count: extensions.length, scope: selection.scope, tree },
        );
        return { dataHandles: [handle] };
      },
    },

    check: {
      description:
        "Run check, lint, fmt:check, test and manifest fmt for every selected extension, and the repo-wide checks, recording each result and its log",
      arguments: z.object({
        repoPath: RepoArg,
        commit: CommitArg,
        concurrency: ConcurrencyArg,
      }),
      execute: async (
        args: { repoPath: string; commit: string; concurrency: number },
        context: MethodContext,
      ) => {
        const signal = context.signal;
        const { sha, tree } = await resolveTarget(
          args.repoPath,
          args.commit,
          signal,
        );
        const sel = await loadSelection(context, tree, sha);
        const tools = await toolInfo();
        const handles: Handle[] = [];
        const failed: string[] = [];
        const base = {
          selectionId: sel.selectionId,
          modelVersion: MODEL_VERSION,
          tools: { deno: tools.deno, swamp: tools.swamp },
          commit: sha,
          tree,
        };

        await withTempHome((home) =>
          withWorktree(args.repoPath, sha, signal, async (wt) => {
            await pool(
              sel.extensions.map((ext) => async () => {
                const name = names.check(tree, ext.slug);
                const stored = await read(context, name);
                if (reusable(stored, sel, tools)) return;
                const results: CheckRecord["results"] = [];
                let log = "";
                let truncated = false;
                for (const task of EXTENSION_TASKS) {
                  const r = await run({
                    cmd: "deno",
                    args: ["task", task],
                    cwd: `${wt}/${ext.dir}`,
                    env: taskEnv(home, tools),
                    signal,
                  });
                  results.push({
                    name: task,
                    status: r.ok ? "passed" : "failed",
                    exitCode: r.code,
                    durationMs: r.durationMs,
                  });
                  log += section(`${ext.dir}: deno task ${task}`, r);
                  truncated ||= r.truncated;
                }
                const fmt = await run({
                  cmd: "swamp",
                  args: ["extension", "fmt", "manifest.yaml", "--check"],
                  cwd: `${wt}/${ext.dir}`,
                  env: swampEnv(tools),
                  signal,
                });
                results.push({
                  name: "manifest-fmt",
                  status: fmt.ok ? "passed" : "failed",
                  exitCode: fmt.code,
                  durationMs: fmt.durationMs,
                });
                log += section(`${ext.dir}: swamp extension fmt --check`, fmt);
                truncated ||= fmt.truncated;

                const status = results.every((x) => x.status === "passed")
                  ? "passed"
                  : "failed";
                if (status === "failed") failed.push(ext.dir);
                const logName = names.log(tree, "check", ext.slug);
                handles.push(
                  await context.createFileWriter("log", logName).writeText(log),
                );
                handles.push(
                  await context.writeResource(
                    "check",
                    name,
                    {
                      ...base,
                      extension: ext.dir,
                      status,
                      results,
                      log: logName,
                      truncated,
                      finishedAt: new Date().toISOString(),
                    } satisfies CheckRecord,
                  ),
                );
              }),
              args.concurrency,
              signal,
            );

            for (const check of sel.repoChecks) {
              const name = names.repoCheck(tree, check);
              if (reusable(await read(context, name), sel, tools)) continue;
              const r = await runRepoCheck(check, wt, home, tools, signal);
              if (r.status === "failed") failed.push(check);
              const logName = names.log(tree, "repo", checkSlug(check));
              handles.push(
                await context.createFileWriter("log", logName).writeText(r.log),
              );
              handles.push(
                await context.writeResource(
                  "repocheck",
                  name,
                  {
                    ...base,
                    name: check,
                    status: r.status,
                    exitCode: r.exitCode,
                    ...(r.reason ? { reason: r.reason } : {}),
                    log: logName,
                    truncated: r.truncated,
                    finishedAt: new Date().toISOString(),
                  } satisfies RepoCheckRecord,
                ),
              );
            }
          })
        );

        context.logger.info("Checked {count} extension(s); {failed} failed", {
          count: sel.extensions.length,
          failed: failed.length,
        });
        if (failed.length > 0) {
          throw new Error(
            `${failed.length} check(s) failed: ${
              failed.slice(0, 10).join(", ")
            }${failed.length > 10 ? ", ..." : ""}`,
          );
        }
        return { dataHandles: handles };
      },
    },

    quality: {
      description:
        "Run swamp extension quality for every selected extension under CI's pass condition, recording each result and its log",
      arguments: z.object({
        repoPath: RepoArg,
        commit: CommitArg,
        concurrency: ConcurrencyArg,
      }),
      execute: async (
        args: { repoPath: string; commit: string; concurrency: number },
        context: MethodContext,
      ) => {
        const signal = context.signal;
        const { sha, tree } = await resolveTarget(
          args.repoPath,
          args.commit,
          signal,
        );
        const sel = await loadSelection(context, tree, sha);
        const tools = await toolInfo();
        const handles: Handle[] = [];
        const failed: string[] = [];

        await withWorktree(args.repoPath, sha, signal, async (wt) => {
          await pool(
            sel.extensions.map((ext) => async () => {
              const name = names.quality(tree, ext.slug);
              if (reusable(await read(context, name), sel, tools)) return;
              const r = await run({
                cmd: "swamp",
                args: ["extension", "quality", "manifest.yaml", "--json"],
                cwd: `${wt}/${ext.dir}`,
                env: swampEnv(tools),
                signal,
              });
              const judged = judgeQuality(r.stdout, r.code);
              if (!judged.passed) failed.push(ext.dir);
              const logName = names.log(tree, "quality", ext.slug);
              handles.push(
                await context.createFileWriter("log", logName).writeText(
                  section(`${ext.dir}: swamp extension quality`, r),
                ),
              );
              handles.push(
                await context.writeResource(
                  "quality",
                  name,
                  {
                    selectionId: sel.selectionId,
                    modelVersion: MODEL_VERSION,
                    tools: { deno: tools.deno, swamp: tools.swamp },
                    commit: sha,
                    tree,
                    extension: ext.dir,
                    status: judged.passed ? "passed" : "failed",
                    ...(judged.reason ? { reason: judged.reason } : {}),
                    ...(judged.percentage !== undefined
                      ? { percentage: judged.percentage }
                      : {}),
                    ...(judged.provisionalPercentage !== undefined
                      ? { provisionalPercentage: judged.provisionalPercentage }
                      : {}),
                    ...(judged.allPassed !== undefined
                      ? { allPassed: judged.allPassed }
                      : {}),
                    log: logName,
                    truncated: r.truncated,
                    finishedAt: new Date().toISOString(),
                  } satisfies QualityRecord,
                ),
              );
            }),
            args.concurrency,
            signal,
          );
        });

        context.logger.info("Scored {count} extension(s); {failed} failed", {
          count: sel.extensions.length,
          failed: failed.length,
        });
        if (failed.length > 0) {
          throw new Error(
            `quality failed for ${failed.length} extension(s): ${
              failed.slice(0, 10).join(", ")
            }${failed.length > 10 ? ", ..." : ""}`,
          );
        }
        return { dataHandles: handles };
      },
    },

    attest: {
      description:
        "Build the attestation for a commit's tree from its recorded results; writes nothing unless every selected check passed for this selection and model version, and, when the change touches the trust root, an approval is given",
      arguments: z.object({
        repoPath: RepoArg,
        commit: CommitArg,
        reviews: z.array(ReviewSchema).default([]).describe(
          "Review verdicts, recorded as asserted by the caller",
        ),
        approvals: z.array(ApprovalSchema).default([]).describe(
          "Approvals, recorded as asserted by the caller; at least one is required when the change touches the trust root",
        ),
      }),
      execute: async (
        args: {
          repoPath: string;
          commit: string;
          reviews: z.infer<typeof ReviewSchema>[];
          approvals: z.infer<typeof ApprovalSchema>[];
        },
        context: MethodContext,
      ) => {
        const { sha, tree } = await resolveTarget(
          args.repoPath,
          args.commit,
          context.signal,
        );
        const sel = await loadSelection(context, tree, sha);
        const problems: string[] = [];
        const judge = (
          what: string,
          stored: Record<string, unknown> | null,
        ): boolean => {
          if (!stored) problems.push(`${what}: no result`);
          else if (stored.selectionId !== sel.selectionId) {
            problems.push(`${what}: recorded for another selection`);
          } else if (stored.modelVersion !== MODEL_VERSION) {
            problems.push(
              `${what}: recorded by model version ${
                String(stored.modelVersion)
              }`,
            );
          } else if (stored.status !== "passed") {
            problems.push(`${what}: ${String(stored.status)}`);
          } else return true;
          return false;
        };

        const extensions: Attestation["extensions"] = [];
        let checks = 0;
        for (const ext of sel.extensions) {
          const c = await read(context, names.check(tree, ext.slug));
          const q = await read(context, names.quality(tree, ext.slug));
          const cOk = judge(`${ext.dir} checks`, c);
          const qOk = judge(`${ext.dir} quality`, q);
          if (cOk && qOk) {
            const cr = CheckSchema.parse(c);
            const qr = QualitySchema.parse(q);
            checks += cr.results.length + 1;
            extensions.push({
              extension: ext.dir,
              checks: cr.results,
              quality: {
                percentage: qr.percentage,
                provisionalPercentage: qr.provisionalPercentage,
              },
            });
          }
        }
        const repoChecks: Attestation["repoChecks"] = [];
        for (const check of sel.repoChecks) {
          if (judge(check, await read(context, names.repoCheck(tree, check)))) {
            checks += 1;
            repoChecks.push({ name: check, status: "passed" });
          }
        }
        for (const review of args.reviews) {
          if (review.verdict !== "pass") {
            problems.push(`review ${review.name}: ${review.verdict}`);
          }
        }
        // The commit's own tooling verified a change to that tooling, so a
        // pass needs a person's sign-off before it can count.
        if (sel.trustRootChanged.length > 0 && args.approvals.length === 0) {
          problems.push(
            `trust root changed (${
              sel.trustRootChanged.slice(0, 3).join(", ")
            }${
              sel.trustRootChanged.length > 3 ? ", ..." : ""
            }): an approval is required`,
          );
        }
        if (problems.length > 0) {
          throw new Error(
            `no attestation for tree ${tree}: ${problems.length} problem(s): ${
              problems.slice(0, 10).join("; ")
            }${problems.length > 10 ? "; ..." : ""}`,
          );
        }

        const tools = await toolInfo();
        const attestation: Attestation = {
          version: 1,
          modelVersion: MODEL_VERSION,
          tools: { deno: tools.deno, swamp: tools.swamp },
          subject: {
            commit: sha,
            tree,
            base: sel.base,
            baseIsAncestor: sel.baseIsAncestor,
          },
          discovery: {
            scope: sel.scope,
            reason: sel.reason,
            selectionId: sel.selectionId,
            extensions: sel.extensions.map((e) => e.dir),
          },
          extensions,
          repoChecks,
          reviews: args.reviews,
          approvals: args.approvals,
          reviewsAndApprovalsCallerAsserted: true,
          coverage: {
            covered: [...COVERAGE.covered],
            notCovered: [...COVERAGE.notCovered],
          },
          trustRootChanged: sel.trustRootChanged,
          requiresSignOff: sel.trustRootChanged.length > 0,
          gate: { allPassed: true, extensions: extensions.length, checks },
          generatedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "attestation",
          names.attestation(tree),
          attestation,
        );
        context.logger.info(
          "Attested tree {tree}: {count} extension(s), {checks} check(s)",
          { tree, count: extensions.length, checks },
        );
        return { dataHandles: [handle] };
      },
    },

    post: {
      description:
        "Push a commit's attestation to refs/attestations/<tree>/<timestamp> on a remote, never forced",
      arguments: z.object({
        repoPath: RepoArg,
        commit: CommitArg,
        remote: z.string().regex(/^[A-Za-z0-9._-]+$/).default("origin")
          .describe("The git remote to push the ref to"),
      }),
      execute: async (
        args: { repoPath: string; commit: string; remote: string },
        context: MethodContext,
      ) => {
        const { sha, tree } = await resolveTarget(
          args.repoPath,
          args.commit,
          context.signal,
        );
        const stored = await read(context, names.attestation(tree));
        if (!stored) {
          throw new Error(`no attestation for tree ${tree}: run attest first`);
        }
        const attestation = AttestationSchema.parse(stored);
        if (attestation.subject.commit !== sha) {
          throw new Error(
            `the attestation for tree ${tree} is for commit ${attestation.subject.commit}, not ${sha}`,
          );
        }
        const posted = await postAttestation(args.repoPath, {
          commit: sha,
          tree,
          document: attestation,
          remote: args.remote,
          signal: context.signal,
        });
        const handle = await context.writeResource(
          "posted",
          names.posted(tree),
          {
            ...posted,
            remote: args.remote,
            commit: sha,
            tree,
            postedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Posted {ref}", { ref: posted.ref });
        return { dataHandles: [handle] };
      },
    },
  },
};

/**
 * The model's version, read from the literal above (the registry catalog needs
 * it written there). A result recorded by another version is not reused.
 */
export const MODEL_VERSION: string = model.version;

interface RepoCheckOutcome {
  status: "passed" | "failed";
  exitCode: number | null;
  reason?: string;
  log: string;
  truncated: boolean;
}

/** One repo-wide check, run in the worktree. */
async function runRepoCheck(
  check: string,
  wt: string,
  home: string,
  tools: Tools,
  signal?: AbortSignal,
): Promise<RepoCheckOutcome> {
  const env = taskEnv(home, tools);
  const outcome = (r: RunResult, judged?: string | null): RepoCheckOutcome => {
    const failed = !r.ok || (judged !== undefined && judged !== null);
    return {
      status: failed ? "failed" : "passed",
      exitCode: r.code,
      ...(judged ? { reason: judged } : {}),
      log: section(check, r),
      truncated: r.truncated,
    };
  };
  if (check === "reserved-data-names") {
    return outcome(
      await run({
        cmd: "deno",
        args: ["task", "--cwd", "scripts/check-reserved-names", "scan", wt],
        cwd: wt,
        env,
        signal,
      }),
    );
  }
  if (check === "bare-import-specifiers" || check === "zod-pin") {
    const bare = check === "bare-import-specifiers";
    const r = await run({
      cmd: "bash",
      args: ["-c", bare ? BARE_SPECIFIER_COMMAND : ZOD_PIN_COMMAND],
      cwd: wt,
      env,
      signal,
    });
    return outcome(
      r,
      bare ? judgeBareSpecifiers(r.stdout) : judgeZodPins(r.stdout),
    );
  }
  const m = check.match(/^scripts\/([^:]+):(.+)$/);
  if (!m) {
    return {
      status: "failed",
      exitCode: null,
      reason: `unknown repo-wide check ${check}`,
      log: `unknown repo-wide check ${check}\n`,
      truncated: false,
    };
  }
  return outcome(
    await run({
      cmd: "deno",
      args: ["task", m[2]],
      cwd: `${wt}/scripts/${m[1]}`,
      env,
      signal,
    }),
  );
}
