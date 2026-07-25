/**
 * Extension maintenance model.
 *
 * Observes a multi-extension repository, audits dependency freshness,
 * plans version bumps, applies changes, and runs quality gates.
 *
 * **Methods:**
 * - `audit` — Pure observation. Scans all extensions, queries registry.
 * - `plan-bump` — Reads audit output, produces a structured change plan.
 * - `apply-bump` — Executes the plan (writes files). Human-approved.
 * - `quality-gate` — Runs check/lint/fmt/test/quality across extensions.
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

/** Global arguments schema for the maintainer model. */
const GlobalArgsSchema = z.object({
  repo_root: z
    .string()
    .default(".")
    .describe("Path to the extension repository root"),
  registry_timeout: z
    .number()
    .int()
    .min(5)
    .max(120)
    .default(30)
    .describe("Seconds to wait for registry queries"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Schema for a single dependency's version status (current vs latest). */
const DepStatusSchema = z.object({
  name: z.string().describe("Dependency package name"),
  current: z.string().describe("Currently pinned version"),
  latest: z.string().describe("Latest available version"),
  stale: z.boolean().describe("Whether current < latest"),
});

/** Schema for a single extension's full dependency and quality status. */
const ExtensionStatusSchema = z.object({
  name: z.string().describe("Extension manifest name"),
  dir: z.string().describe("Directory relative to repo root"),
  version: z.string().describe("Current manifest version"),
  qualityScore: z.number().describe("Quality rubric percentage (0-100)"),
  npmDeps: z.array(DepStatusSchema).describe("npm dependency status"),
  testingDep: DepStatusSchema.nullable().describe("swamp-testing status"),
  manifestDeps: z.array(DepStatusSchema).describe("Manifest pin status"),
  stale: z.boolean().describe("Any dependency is stale"),
});

/** Schema for the complete audit summary resource. */
const AuditSummarySchema = z.object({
  scannedAt: z.string().describe("ISO 8601 audit timestamp"),
  repoRoot: z.string().describe("Repository root path"),
  totalExtensions: z.number().describe("Total extensions scanned"),
  staleCount: z.number().describe("Extensions with stale deps"),
  categories: z.object({
    npm: z.number().describe("Extensions with stale npm deps"),
    testing: z.number().describe("Extensions with stale test framework"),
    manifest: z.number().describe("Extensions with stale manifest pins"),
  }),
  extensions: z.array(ExtensionStatusSchema),
});

/** Schema for a single extension's planned bump entry. */
const BumpPlanEntrySchema = z.object({
  name: z.string().describe("Extension manifest name"),
  dir: z.string().describe("Directory relative to repo root"),
  currentVersion: z.string().describe("Current manifest version"),
  nextVersion: z.string().describe("Planned next CalVer version"),
  changes: z.array(z.object({
    file: z.string().describe("File path relative to extension dir"),
    find: z.string().describe("Version string to replace"),
    replace: z.string().describe("Replacement version string"),
    category: z.enum([
      "npm",
      "testing",
      "manifest-pin",
      "manifest-version",
      "source-version",
    ]),
  })),
  releaseNotes: z.string().describe("Generated RELEASE_NOTES.md content"),
});

/** Schema for the complete bump plan resource. */
const BumpPlanSchema = z.object({
  plannedAt: z.string().describe("ISO 8601 plan timestamp"),
  totalEntries: z.number().describe("Extensions to bump"),
  entries: z.array(BumpPlanEntrySchema),
});

/** Schema for the apply-bump result resource. */
const ApplyResultSchema = z.object({
  appliedAt: z.string().describe("ISO 8601 apply timestamp"),
  extensionsBumped: z.number(),
  filesModified: z.number(),
  errors: z.array(z.object({
    extension: z.string(),
    error: z.string(),
  })),
});

/** Schema for the quality-gate result resource. */
const QualityResultSchema = z.object({
  ranAt: z.string().describe("ISO 8601 timestamp"),
  totalExtensions: z.number(),
  passed: z.number(),
  failed: z.number(),
  results: z.array(z.object({
    name: z.string(),
    dir: z.string(),
    check: z.boolean(),
    lint: z.boolean(),
    fmt: z.boolean(),
    test: z.boolean(),
    quality: z.number().describe("Quality score 0-100"),
    extensionFmt: z.boolean(),
    errors: z.array(z.string()),
  })),
});

// =============================================================================
// Helpers
// =============================================================================

/** Run a command and return stdout, or null on failure. */
async function run(
  cmd: string[],
  cwd?: string,
): Promise<{ stdout: string; success: boolean }> {
  const proc = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    success: output.success,
  };
}

/** Query npm registry for latest version of a package. */
async function npmLatest(pkg: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://registry.npmjs.org/${pkg}/latest`,
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.version ?? null;
  } catch {
    return null;
  }
}

/** Query JSR for latest version of a scoped package. */
async function jsrLatest(scope: string, name: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://jsr.io/@${scope}/${name}/meta.json`,
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.latest ?? null;
  } catch {
    return null;
  }
}

/** Discover all extensions (directories containing manifest.yaml). */
async function discoverExtensions(repoRoot: string): Promise<string[]> {
  const dirs: string[] = [];
  const findCmd = await run([
    "find",
    repoRoot,
    "-name",
    "manifest.yaml",
    "-not",
    "-path",
    "*/.worktrees/*",
    "-not",
    "-path",
    "*/.swamp/*",
    "-maxdepth",
    "3",
  ]);
  if (!findCmd.success) return dirs;
  for (const line of findCmd.stdout.trim().split("\n")) {
    if (!line) continue;
    const dir = line.replace(/\/manifest\.yaml$/, "");
    dirs.push(dir);
  }
  return dirs.sort();
}

/** Extract npm import versions from .ts source files in an extension. */
async function extractNpmImports(extDir: string): Promise<Map<string, string>> {
  const imports = new Map<string, string>();
  const findCmd = await run([
    "find",
    `${extDir}/extensions`,
    "-name",
    "*.ts",
    "-not",
    "-name",
    "*_test.ts",
  ]);
  if (!findCmd.success) return imports;

  for (const file of findCmd.stdout.trim().split("\n")) {
    if (!file) continue;
    const grepCmd = await run(["grep", "-oh", 'npm:[^"]*', file]);
    if (!grepCmd.success) continue;
    for (const match of grepCmd.stdout.trim().split("\n")) {
      if (!match) continue;
      // npm:@aws-sdk/client-s3@3.1094.0 → @aws-sdk/client-s3, 3.1094.0
      const atIdx = match.lastIndexOf("@");
      if (atIdx <= 4) continue; // skip if no version separator
      const pkg = match.slice(4, atIdx); // strip "npm:"
      const ver = match.slice(atIdx + 1);
      imports.set(pkg, ver);
    }
  }
  return imports;
}

/** Read swamp-testing version from deno.json. */
async function readTestingVersion(extDir: string): Promise<string | null> {
  try {
    const content = await Deno.readTextFile(`${extDir}/deno.json`);
    const deno = JSON.parse(content);
    const imports = deno.imports ?? {};
    const testing: string | undefined = imports["@systeminit/swamp-testing"];
    if (!testing) return null;
    // jsr:@systeminit/swamp-testing@0.20260604.20
    const match = testing.match(/@([\d.]+)$/);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/** Read manifest dependency pins. */
async function readManifestDeps(
  extDir: string,
): Promise<Array<{ name: string; version: string }>> {
  try {
    const content = await Deno.readTextFile(`${extDir}/manifest.yaml`);
    const deps: Array<{ name: string; version: string }> = [];
    const lines = content.split("\n");
    let inDeps = false;
    for (const line of lines) {
      if (line.match(/^dependencies:\s*$/)) {
        inDeps = true;
        continue;
      }
      if (inDeps && line.match(/^\s+-\s+"/)) {
        const match = line.match(/"([^@]+)@([^"]+)"/);
        if (match) {
          deps.push({ name: match[1]!, version: match[2]! });
        }
      } else if (inDeps && !line.match(/^\s+-/) && !line.match(/^\s*$/)) {
        inDeps = false;
      }
    }
    return deps;
  } catch {
    return [];
  }
}

/** Get extension quality score via swamp extension quality. */
async function getQualityScore(extDir: string): Promise<number> {
  const result = await run(
    ["swamp", "extension", "quality", "manifest.yaml", "--json"],
    extDir,
  );
  if (!result.success) return 0;
  try {
    const data = JSON.parse(result.stdout);
    return data.percentage ?? 0;
  } catch {
    return 0;
  }
}

/** Query registry for latest version of a swamp extension. */
async function registryLatest(extName: string): Promise<string | null> {
  const result = await run([
    "swamp",
    "extension",
    "info",
    extName,
    "--json",
  ]);
  if (!result.success) return null;
  try {
    const data = JSON.parse(result.stdout);
    return data.latestVersion ?? null;
  } catch {
    return null;
  }
}

/** Compute next CalVer version for today. */
function nextCalVer(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}.1`;
}

/** Read the version field from manifest.yaml. */
async function readManifestVersion(extDir: string): Promise<string> {
  try {
    const content = await Deno.readTextFile(`${extDir}/manifest.yaml`);
    const match = content.match(/^version:\s*"([^"]+)"/m);
    return match ? match[1]! : "unknown";
  } catch {
    return "unknown";
  }
}

/** Read the extension name from manifest.yaml. */
async function readManifestName(extDir: string): Promise<string> {
  try {
    const content = await Deno.readTextFile(`${extDir}/manifest.yaml`);
    const match = content.match(/^name:\s*"([^"]+)"/m);
    return match ? match[1]! : "unknown";
  } catch {
    return "unknown";
  }
}

// =============================================================================
// Model Definition
// =============================================================================

/**
 * Extension maintenance model definition.
 *
 * Provides four methods for managing a multi-extension repository:
 * - `audit` — Observe dependency freshness across all extensions.
 * - `plan-bump` — Compute a structured change plan from audit data.
 * - `apply-bump` — Execute the plan (human-approved write step).
 * - `quality-gate` — Run deno check/lint/fmt/test and quality scoring.
 *
 * Each method produces a typed resource stored as versioned swamp data,
 * enabling queries over maintenance history via CEL.
 */
export const model = {
  type: "@webframp/extension-maintenance/maintainer",
  version: "2026.07.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    audit: {
      description: "Full dependency audit report across all extensions.",
      schema: AuditSummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    plan: {
      description: "Structured bump plan for human review.",
      schema: BumpPlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    apply: {
      description: "Result of applying a bump plan.",
      schema: ApplyResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    quality: {
      description: "Quality gate results for all extensions.",
      schema: QualityResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    audit: {
      description:
        "Scan all extensions, query registries, produce a staleness report. Pure observation, zero side effects.",
      arguments: z.object({
        filter: z
          .string()
          .optional()
          .describe("Glob pattern to filter extensions by directory name"),
      }),
      execute: async (
        args: { filter?: string },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          log: (level: string, message: string) => void;
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const { repo_root } = context.globalArgs;
        const resolvedRoot = repo_root === "." ? Deno.cwd() : repo_root;

        context.log("info", `Scanning extensions in ${resolvedRoot}`);
        const extDirs = await discoverExtensions(resolvedRoot);
        context.log("info", `Found ${extDirs.length} extensions`);

        // Deduplicate npm packages to minimize registry queries
        const allNpmPkgs = new Set<string>();
        const extNpmMaps: Map<string, Map<string, string>> = new Map();

        for (const dir of extDirs) {
          if (args.filter && !dir.includes(args.filter)) continue;
          const npmImports = await extractNpmImports(dir);
          extNpmMaps.set(dir, npmImports);
          for (const pkg of npmImports.keys()) {
            allNpmPkgs.add(pkg);
          }
        }

        // Batch-query npm registry
        context.log(
          "info",
          `Querying npm registry for ${allNpmPkgs.size} packages`,
        );
        const npmLatestVersions = new Map<string, string>();
        for (const pkg of allNpmPkgs) {
          const latest = await npmLatest(pkg);
          if (latest) npmLatestVersions.set(pkg, latest);
        }

        // Query swamp-testing latest
        const testingLatest = await jsrLatest("systeminit", "swamp-testing");
        context.log("info", `swamp-testing latest: ${testingLatest}`);

        // Build per-extension status
        const extensions: z.infer<typeof ExtensionStatusSchema>[] = [];
        let staleNpm = 0;
        let staleTesting = 0;
        let staleManifest = 0;

        for (const dir of extDirs) {
          if (args.filter && !dir.includes(args.filter)) continue;

          const name = await readManifestName(dir);
          const version = await readManifestVersion(dir);
          const relDir = dir.replace(resolvedRoot + "/", "");

          // npm deps
          const npmImports = extNpmMaps.get(dir) ?? new Map();
          const npmDeps: z.infer<typeof DepStatusSchema>[] = [];
          let hasStaleNpm = false;
          for (const [pkg, ver] of npmImports) {
            const latest = npmLatestVersions.get(pkg) ?? ver;
            const stale = ver !== latest;
            if (stale) hasStaleNpm = true;
            npmDeps.push({ name: pkg, current: ver, latest, stale });
          }
          if (hasStaleNpm) staleNpm++;

          // testing dep
          const testVer = await readTestingVersion(dir);
          let testingDep: z.infer<typeof DepStatusSchema> | null = null;
          let hasStaleTesting = false;
          if (testVer && testingLatest) {
            const stale = testVer !== testingLatest;
            if (stale) hasStaleTesting = true;
            testingDep = {
              name: "@systeminit/swamp-testing",
              current: testVer,
              latest: testingLatest,
              stale,
            };
          }
          if (hasStaleTesting) staleTesting++;

          // manifest deps
          const mDeps = await readManifestDeps(dir);
          const manifestDeps: z.infer<typeof DepStatusSchema>[] = [];
          let hasStaleManifest = false;
          for (const dep of mDeps) {
            const latest = await registryLatest(dep.name);
            const stale = latest !== null && dep.version !== latest;
            if (stale) hasStaleManifest = true;
            manifestDeps.push({
              name: dep.name,
              current: dep.version,
              latest: latest ?? dep.version,
              stale,
            });
          }
          if (hasStaleManifest) staleManifest++;

          // quality
          const qualityScore = await getQualityScore(dir);

          const isStale = hasStaleNpm || hasStaleTesting || hasStaleManifest;
          extensions.push({
            name,
            dir: relDir,
            version,
            qualityScore,
            npmDeps,
            testingDep,
            manifestDeps,
            stale: isStale,
          });
        }

        const staleCount = extensions.filter((e) => e.stale).length;
        context.log(
          "info",
          `Audit complete: ${staleCount}/${extensions.length} stale`,
        );

        const handle = await context.writeResource("audit", "latest", {
          scannedAt: new Date().toISOString(),
          repoRoot: resolvedRoot,
          totalExtensions: extensions.length,
          staleCount,
          categories: {
            npm: staleNpm,
            testing: staleTesting,
            manifest: staleManifest,
          },
          extensions,
        });
        return { dataHandles: [handle] };
      },
    },

    "plan-bump": {
      description:
        "Read the latest audit, produce a structured plan of changes. No side effects.",
      arguments: z.object({
        skip_testing: z
          .boolean()
          .default(false)
          .describe(
            "Exclude swamp-testing bumps from the plan (test-only, no version bump needed)",
          ),
      }),
      execute: async (
        args: { skip_testing?: boolean },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            specName: string,
            name: string,
          ) => Promise<Record<string, unknown> | null>;
          log: (level: string, message: string) => void;
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const audit = await context.readResource("audit", "latest");
        if (!audit) {
          throw new Error(
            "No audit data found. Run the audit method first.",
          );
        }

        const extensions = (audit as {
          extensions: Array<{
            name: string;
            dir: string;
            version: string;
            stale: boolean;
            npmDeps: Array<
              { name: string; current: string; latest: string; stale: boolean }
            >;
            testingDep:
              | { current: string; latest: string; stale: boolean }
              | null;
            manifestDeps: Array<
              { name: string; current: string; latest: string; stale: boolean }
            >;
          }>;
        }).extensions;

        const nextVer = nextCalVer();
        const entries: z.infer<typeof BumpPlanEntrySchema>[] = [];

        for (const ext of extensions) {
          if (!ext.stale) continue;

          const changes: z.infer<typeof BumpPlanEntrySchema>["changes"] = [];
          const noteLines: string[] = [];

          // npm dep changes (these modify shipped source files → version bump)
          const staleNpm = ext.npmDeps.filter((d) => d.stale);
          for (const dep of staleNpm) {
            changes.push({
              file: "extensions/**/*.ts",
              find: `${dep.name}@${dep.current}`,
              replace: `${dep.name}@${dep.latest}`,
              category: "npm",
            });
          }
          if (staleNpm.length > 0) {
            const grouped = new Map<string, string[]>();
            for (const dep of staleNpm) {
              const base = dep.name.split("/").slice(0, -1).join("/") ||
                dep.name;
              if (!grouped.has(base)) grouped.set(base, []);
              grouped.get(base)!.push(`${dep.current} → ${dep.latest}`);
            }
            for (const [base, versions] of grouped) {
              noteLines.push(
                `**Changed:** Bump ${base} ${versions[0]}`,
              );
            }
          }

          // testing dep (test-only → no version bump unless skip_testing=false)
          if (!args.skip_testing && ext.testingDep?.stale) {
            changes.push({
              file: "deno.json",
              find: ext.testingDep.current,
              replace: ext.testingDep.latest,
              category: "testing",
            });
          }

          // manifest dep pins (modifies manifest.yaml → version bump)
          const staleManifest = ext.manifestDeps.filter((d) => d.stale);
          for (const dep of staleManifest) {
            changes.push({
              file: "manifest.yaml",
              find: `${dep.name}@${dep.current}`,
              replace: `${dep.name}@${dep.latest}`,
              category: "manifest-pin",
            });
            noteLines.push(
              `**Changed:** Bump ${dep.name} ${dep.current} → ${dep.latest}`,
            );
          }

          // Only produce an entry if there are shipped-file changes
          const hasShippedChanges = changes.some(
            (c) => c.category !== "testing",
          );
          if (!hasShippedChanges && args.skip_testing) continue;

          // manifest version bump
          if (hasShippedChanges) {
            changes.push({
              file: "manifest.yaml",
              find: ext.version,
              replace: nextVer,
              category: "manifest-version",
            });
            changes.push({
              file: "extensions/**/*.ts",
              find: `version: "${ext.version}"`,
              replace: `version: "${nextVer}"`,
              category: "source-version",
            });
          }

          const releaseNotes = `## ${nextVer}\n\n${noteLines.join("\n\n")}\n`;

          entries.push({
            name: ext.name,
            dir: ext.dir,
            currentVersion: ext.version,
            nextVersion: hasShippedChanges ? nextVer : ext.version,
            changes,
            releaseNotes,
          });
        }

        context.log("info", `Plan: ${entries.length} extensions to bump`);

        const handle = await context.writeResource("plan", "latest", {
          plannedAt: new Date().toISOString(),
          totalEntries: entries.length,
          entries,
        });
        return { dataHandles: [handle] };
      },
    },

    "apply-bump": {
      description:
        "Execute the latest plan. Writes files. Requires human approval.",
      arguments: z.object({
        dry_run: z
          .boolean()
          .default(false)
          .describe("If true, report what would change without writing"),
      }),
      execute: async (
        args: { dry_run?: boolean },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          readResource: (
            specName: string,
            name: string,
          ) => Promise<Record<string, unknown> | null>;
          log: (level: string, message: string) => void;
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const { repo_root } = context.globalArgs;
        const resolvedRoot = repo_root === "." ? Deno.cwd() : repo_root;

        const plan = await context.readResource("plan", "latest");
        if (!plan) {
          throw new Error("No plan found. Run plan-bump first.");
        }

        const entries = (plan as {
          entries: Array<{
            name: string;
            dir: string;
            changes: Array<
              { file: string; find: string; replace: string; category: string }
            >;
            releaseNotes: string;
            nextVersion: string;
            currentVersion: string;
          }>;
        }).entries;

        let filesModified = 0;
        const errors: Array<{ extension: string; error: string }> = [];

        for (const entry of entries) {
          const extDir = `${resolvedRoot}/${entry.dir}`;
          context.log(
            "info",
            `${args.dry_run ? "[DRY RUN] " : ""}Applying: ${entry.name}`,
          );

          try {
            for (const change of entry.changes) {
              if (change.file.includes("*")) {
                // Glob pattern — find matching files
                const findResult = await run([
                  "find",
                  `${extDir}/extensions`,
                  "-name",
                  "*.ts",
                  "-not",
                  "-name",
                  "*_test.ts",
                ]);
                if (!findResult.success) continue;
                for (const file of findResult.stdout.trim().split("\n")) {
                  if (!file) continue;
                  if (!args.dry_run) {
                    const content = await Deno.readTextFile(file);
                    if (content.includes(change.find)) {
                      const updated = content.replaceAll(
                        change.find,
                        change.replace,
                      );
                      await Deno.writeTextFile(file, updated);
                      filesModified++;
                    }
                  }
                }
              } else {
                // Specific file
                const filePath = `${extDir}/${change.file}`;
                if (!args.dry_run) {
                  try {
                    const content = await Deno.readTextFile(filePath);
                    if (content.includes(change.find)) {
                      const updated = content.replaceAll(
                        change.find,
                        change.replace,
                      );
                      await Deno.writeTextFile(filePath, updated);
                      filesModified++;
                    }
                  } catch {
                    // File may not exist for this extension
                  }
                }
              }
            }

            // Write RELEASE_NOTES.md
            if (!args.dry_run && entry.releaseNotes) {
              await Deno.writeTextFile(
                `${extDir}/RELEASE_NOTES.md`,
                entry.releaseNotes,
              );
              filesModified++;
            }
          } catch (err: unknown) {
            errors.push({
              extension: entry.name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        context.log(
          "info",
          `Apply complete: ${entries.length} extensions, ${filesModified} files${
            args.dry_run ? " (dry run)" : ""
          }`,
        );

        const handle = await context.writeResource("apply", "latest", {
          appliedAt: new Date().toISOString(),
          extensionsBumped: entries.length,
          filesModified,
          errors,
        });
        return { dataHandles: [handle] };
      },
    },

    "quality-gate": {
      description:
        "Run check/lint/fmt/test and quality scoring across all (or filtered) extensions.",
      arguments: z.object({
        filter: z
          .string()
          .optional()
          .describe("Glob pattern to filter extensions by directory name"),
        stop_on_failure: z
          .boolean()
          .default(false)
          .describe("Stop at first failing extension"),
      }),
      execute: async (
        args: { filter?: string; stop_on_failure?: boolean },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          log: (level: string, message: string) => void;
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const { repo_root } = context.globalArgs;
        const resolvedRoot = repo_root === "." ? Deno.cwd() : repo_root;

        const extDirs = await discoverExtensions(resolvedRoot);
        const results: z.infer<typeof QualityResultSchema>["results"] = [];
        let passed = 0;
        let failed = 0;

        for (const dir of extDirs) {
          if (args.filter && !dir.includes(args.filter)) continue;

          // Skip extensions without deno.json (workflow-only, etc.)
          try {
            await Deno.stat(`${dir}/deno.json`);
          } catch {
            continue;
          }

          const name = await readManifestName(dir);
          const relDir = dir.replace(resolvedRoot + "/", "");
          const errors: string[] = [];

          context.log("info", `Quality gate: ${name}`);

          const checkResult = await run(["deno", "task", "check"], dir);
          const lintResult = await run(["deno", "task", "lint"], dir);
          const fmtResult = await run(["deno", "task", "fmt"], dir);
          const testResult = await run(["deno", "task", "test"], dir);

          if (!checkResult.success) errors.push("check failed");
          if (!lintResult.success) errors.push("lint failed");
          if (!fmtResult.success) errors.push("fmt failed");
          if (!testResult.success) errors.push("test failed");

          const quality = await getQualityScore(dir);

          // Extension fmt
          const extFmtResult = await run(
            ["swamp", "extension", "fmt", "manifest.yaml", "--check", "--json"],
            dir,
          );
          if (!extFmtResult.success) errors.push("extension fmt failed");

          const allPassed = errors.length === 0;
          if (allPassed) passed++;
          else failed++;

          results.push({
            name,
            dir: relDir,
            check: checkResult.success,
            lint: lintResult.success,
            fmt: fmtResult.success,
            test: testResult.success,
            quality,
            extensionFmt: extFmtResult.success,
            errors,
          });

          if (!allPassed && args.stop_on_failure) {
            context.log("warning", `Stopping on failure: ${name}`);
            break;
          }
        }

        context.log(
          "info",
          `Quality gate complete: ${passed} passed, ${failed} failed`,
        );

        const handle = await context.writeResource("quality", "latest", {
          ranAt: new Date().toISOString(),
          totalExtensions: results.length,
          passed,
          failed,
          results,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
