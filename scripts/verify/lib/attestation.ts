/**
 * Assembles an attestation from what a verification recorded in its output
 * directory, and the identity of the commit it ran against.
 *
 * @module
 */

import { gitText } from "./git.ts";
import {
  type Attestation,
  ATTESTATION_VERSION,
  type DiscoveryRecord,
  type ReviewRecord,
  type StepRecord,
} from "./types.ts";

/**
 * Paths whose change alters what verification checks or what an attestation
 * says. A PR touching any of them cannot have its attestation taken at face
 * value, because the changed tooling produced it.
 */
export const TRUST_ROOT = [
  "scripts/verify",
  "scripts/ci-discover",
  "scripts/check-reserved-names",
  "verification",
  ".github/workflows",
  "CLAUDE.md",
  "AGENTS.md",
] as const;

async function readJsonDir<T>(dir: string): Promise<T[]> {
  const out: T[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(".json")) {
        out.push(JSON.parse(await Deno.readTextFile(`${dir}/${e.name}`)) as T);
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return out;
}

export function summarizeGate(steps: readonly StepRecord[]) {
  const passed = steps.filter((s) => s.status === "passed").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;
  const failed = steps.filter((s) => s.status === "failed").length;
  return {
    allPassed: steps.length > 0 && failed === 0 && skipped === 0,
    stepsTotal: steps.length,
    stepsPassed: passed,
    stepsSkipped: skipped,
  };
}

async function swampVersion(): Promise<string> {
  try {
    const out = await new Deno.Command("swamp", {
      args: ["--version"],
      stdout: "piped",
      stderr: "null",
    }).output();
    return out.success
      ? new TextDecoder().decode(out.stdout).trim()
      : "unknown";
  } catch {
    return "unavailable";
  }
}

export async function buildAttestation(opts: {
  repoDir: string;
  outDir: string;
  commit: string;
  branch: string;
  now?: Date;
}): Promise<Attestation> {
  const head = await gitText(["rev-parse", "HEAD"], { cwd: opts.repoDir });
  if (head !== opts.commit) {
    throw new Error(
      `verified checkout is at ${head}, not the commit being attested (${opts.commit})`,
    );
  }
  const tree = await gitText(["rev-parse", `${opts.commit}^{tree}`], {
    cwd: opts.repoDir,
  });

  let discovery: DiscoveryRecord;
  try {
    discovery = JSON.parse(
      await Deno.readTextFile(`${opts.outDir}/discover.json`),
    );
  } catch {
    throw new Error(
      `no discover.json in ${opts.outDir}: run the discover step first`,
    );
  }

  const steps = (await readJsonDir<StepRecord>(`${opts.outDir}/steps`))
    .sort((a, b) => a.name.localeCompare(b.name));
  const reviews = (await readJsonDir<ReviewRecord>(`${opts.outDir}/reviews`))
    .sort((a, b) => a.name.localeCompare(b.name));

  const startedAt = steps.map((s) => s.startedAt).sort()[0] ??
    (opts.now ?? new Date()).toISOString();

  return {
    version: ATTESTATION_VERSION,
    subject: {
      commit: opts.commit,
      tree,
      base: discovery.base,
      branch: opts.branch,
    },
    discovery,
    steps,
    reviews,
    environment: {
      deno: Deno.version.deno,
      swamp: await swampVersion(),
      os: Deno.build.os,
    },
    timing: {
      startedAt,
      completedAt: (opts.now ?? new Date()).toISOString(),
    },
    gate: summarizeGate(steps),
  };
}
