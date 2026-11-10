/**
 * Pre-PR verification and attestation tool.
 *
 * Verification runs the same per-extension tasks CI runs, records each result,
 * and assembles an attestation bound to the commit's tree hash. The
 * attestation is stored as a git ref; CI recomputes what the PR touches and
 * judges the attestation against it.
 *
 * Usage (run from the repository root):
 *   discover  --out DIR --base REF
 *   checks    --out DIR [--concurrency N]
 *   manifests --out DIR [--concurrency N]
 *   quality   --out DIR [--concurrency N]
 *   step      --out DIR --name NAME -- COMMAND...
 *   review    --out DIR --name NAME --file RESULT
 *   build     --out DIR --commit SHA --branch NAME
 *   post      --file ATTESTATION [--remote origin]
 *   validate  --commit SHA --base SHA [--remote origin] [--expect-deno V]
 *             [--summary-file PATH] [--strict]
 *
 * @module
 */

import { buildAttestation, TRUST_ROOT } from "./lib/attestation.ts";
import { git, gitText } from "./lib/git.ts";
import { fetchLatestAttestation, postAttestation } from "./lib/refstore.ts";
import {
  runExtensionTasks,
  runManifestFmt,
  runQuality,
  runRecorded,
} from "./lib/steps.ts";
import type {
  Attestation,
  DiscoveryRecord,
  ReviewRecord,
} from "./lib/types.ts";
import { renderSummary, validateAttestation } from "./lib/validate.ts";
import { determineVerdict, toReviewKind } from "./lib/verdict.ts";

export interface Parsed {
  flags: Map<string, string | true>;
  rest: string[];
}

/** `--k v` pairs and bare `--k` switches; everything after `--` is `rest`. */
export function parseFlags(argv: readonly string[]): Parsed {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(a.slice(2), next);
        i++;
      } else {
        flags.set(a.slice(2), true);
      }
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  return { flags, rest };
}

function need(p: Parsed, key: string): string {
  const v = p.flags.get(key);
  if (typeof v !== "string") throw new Error(`--${key} is required`);
  return v;
}

function opt(p: Parsed, key: string): string | undefined {
  const v = p.flags.get(key);
  return typeof v === "string" ? v : undefined;
}

function conc(p: Parsed): number {
  const n = Number(opt(p, "concurrency") ?? "4");
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("--concurrency must be >= 1");
  }
  return n;
}

async function readDiscovery(outDir: string): Promise<DiscoveryRecord> {
  return JSON.parse(await Deno.readTextFile(`${outDir}/discover.json`));
}

/** Runs ci-discover and returns its parsed selection. */
export async function runDiscovery(
  repoRoot: string,
  base: string,
): Promise<{ scope: "full" | "scoped"; reason: string; extensions: string[] }> {
  const out = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-read",
      "--allow-run",
      "--allow-env",
      `${repoRoot}/scripts/ci-discover/main.ts`,
      "--diff-base",
      base,
      "--repo-root",
      repoRoot,
    ],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `ci-discover failed: ${new TextDecoder().decode(out.stderr).trim()}`,
    );
  }
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

function tally(records: { status: string }[], what: string): number {
  const failed = records.filter((r) => r.status !== "passed").length;
  console.log(`${what}: ${records.length - failed}/${records.length} passed`);
  return failed;
}

async function run(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const p = parseFlags(args);
  const root = Deno.cwd();

  switch (cmd) {
    case "discover": {
      const out = need(p, "out");
      const base = await gitText(["rev-parse", need(p, "base")], { cwd: root });
      const d = await runDiscovery(root, base);
      await Deno.mkdir(out, { recursive: true });
      const rec: DiscoveryRecord = { ...d, base };
      await Deno.writeTextFile(
        `${out}/discover.json`,
        JSON.stringify(rec, null, 2) + "\n",
      );
      console.log(
        `discovered ${rec.extensions.length} extension(s), scope=${rec.scope}`,
      );
      return 0;
    }
    case "checks": {
      const out = need(p, "out");
      const d = await readDiscovery(out);
      const r = await runExtensionTasks(out, root, d.extensions, conc(p));
      return tally(r, "extension tasks") > 0 ? 1 : 0;
    }
    case "manifests": {
      const out = need(p, "out");
      const d = await readDiscovery(out);
      const r = await runManifestFmt(out, root, d.extensions, conc(p));
      return tally(r, "manifest fmt") > 0 ? 1 : 0;
    }
    case "quality": {
      const out = need(p, "out");
      const d = await readDiscovery(out);
      const r = await runQuality(out, root, d.extensions, conc(p));
      return tally(r, "quality") > 0 ? 1 : 0;
    }
    case "step": {
      if (p.rest.length === 0) throw new Error("step needs a command after --");
      const rec = await runRecorded(need(p, "out"), {
        name: need(p, "name"),
        cmd: p.rest,
        cwd: root,
      });
      console.log(`${rec.name}: ${rec.status}`);
      return rec.status === "passed" ? 0 : 1;
    }
    case "review": {
      const out = need(p, "out");
      const name = need(p, "name");
      const verdict = determineVerdict(
        await Deno.readTextFile(need(p, "file")),
      );
      const rec: ReviewRecord = { name, verdict: toReviewKind(verdict) };
      await Deno.mkdir(`${out}/reviews`, { recursive: true });
      await Deno.writeTextFile(
        `${out}/reviews/${encodeURIComponent(name)}.json`,
        JSON.stringify(rec) + "\n",
      );
      console.log(`GATE_VERDICT: ${rec.verdict}`);
      return rec.verdict === "pass" ? 0 : 1;
    }
    case "build": {
      const out = need(p, "out");
      const att = await buildAttestation({
        repoDir: root,
        outDir: out,
        commit: need(p, "commit"),
        branch: need(p, "branch"),
      });
      await Deno.writeTextFile(
        `${out}/attestation.json`,
        JSON.stringify(att, null, 2) + "\n",
      );
      console.log(
        `attestation for tree ${
          att.subject.tree.slice(0, 12)
        }: ${att.gate.stepsPassed}/${att.gate.stepsTotal} steps passed, ${att.gate.stepsSkipped} skipped`,
      );
      if (!att.gate.allPassed) {
        console.error("not every step passed; do not post this attestation");
        return 1;
      }
      return 0;
    }
    case "post": {
      const att = JSON.parse(
        await Deno.readTextFile(need(p, "file")),
      ) as Attestation;
      const posted = await postAttestation(root, att, {
        remote: opt(p, "remote"),
      });
      console.log(`posted ${posted.ref}`);
      return 0;
    }
    case "validate": {
      const commit = need(p, "commit");
      const base = need(p, "base");
      const remote = opt(p, "remote") ?? "origin";
      const headTree = await gitText(["rev-parse", `${commit}^{tree}`], {
        cwd: root,
      });
      const found = await fetchLatestAttestation(root, headTree, remote);
      let md: string;
      let code: number;
      if (!found) {
        const r = {
          errors: [
            `no attestation is posted for tree ${headTree.slice(0, 12)}`,
          ],
          warnings: [],
          gate: { allPassed: false, passed: 0, failed: 0, skipped: 0 },
        };
        md = renderSummary(commit, headTree, null, r);
        code = 1;
      } else {
        const expected = await runDiscovery(root, base);
        const changed = await git(
          [
            "diff",
            "--name-only",
            "--no-renames",
            `${base}...${commit}`,
            "--",
            ...TRUST_ROOT,
          ],
          { cwd: root },
        );
        if (!changed.ok) {
          throw new Error(`trust-root diff failed: ${changed.stderr.trim()}`);
        }
        const result = validateAttestation({
          attestation: found.attestation,
          headCommit: commit,
          headTree,
          expectedExtensions: expected.extensions,
          trustRootChanges: changed.stdout.split("\n").filter(Boolean),
          now: new Date(),
          expectDeno: opt(p, "expect-deno"),
          strict: p.flags.has("strict"),
        });
        md = renderSummary(commit, headTree, found.ref, result);
        code = result.errors.length > 0 ? 1 : 0;
      }
      console.log(md);
      const summary = opt(p, "summary-file");
      if (summary) await Deno.writeTextFile(summary, md);
      return code;
    }
    default:
      console.error(
        "usage: verify <discover|checks|manifests|quality|step|review|build|post|validate> [flags]",
      );
      return 2;
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await run(Deno.args));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    Deno.exit(2);
  }
}
