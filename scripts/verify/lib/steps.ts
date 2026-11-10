/**
 * Runs verification commands and records each outcome as a small JSON file,
 * so a later step can assemble the attestation from what actually ran. A
 * workflow step is a thin wrapper around one of these.
 *
 * Layout under the output directory:
 *   discover.json        what the diff selected
 *   steps/<name>.json    one StepRecord per command run
 *   logs/<name>.log      the command's combined output
 *   reviews/<name>.json  one ReviewRecord per review
 *
 * @module
 */

import { EXTENSION_TASKS, type StepRecord } from "./types.ts";

/** A filesystem-safe, collision-free file stem for a step name. */
export function fileStem(name: string): string {
  return encodeURIComponent(name).replaceAll("%", "=");
}

export interface RunSpec {
  name: string;
  extension?: string;
  cmd: string[];
  cwd: string;
  env?: Record<string, string>;
  /**
   * Decides pass/fail from the output when exit status alone is not enough.
   * Returning a string marks the step failed with that reason.
   */
  judge?: (stdout: string) => string | null;
}

export async function runRecorded(
  outDir: string,
  spec: RunSpec,
): Promise<StepRecord> {
  const startedAt = new Date();
  const stem = fileStem(spec.name);
  await Deno.mkdir(`${outDir}/steps`, { recursive: true });
  await Deno.mkdir(`${outDir}/logs`, { recursive: true });

  let record: StepRecord;
  let log = "";
  try {
    const out = await new Deno.Command(spec.cmd[0], {
      args: spec.cmd.slice(1),
      cwd: spec.cwd,
      env: spec.env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    const stdout = dec.decode(out.stdout);
    log = stdout + dec.decode(out.stderr);
    const judged = out.success && spec.judge ? spec.judge(stdout) : null;
    record = {
      name: spec.name,
      extension: spec.extension,
      status: out.success && judged === null ? "passed" : "failed",
      exitCode: out.code,
      durationMs: Date.now() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      ...(judged ? { reason: judged } : {}),
    };
  } catch (err) {
    // The command could not start (missing binary). That is a failure, not a
    // pass and not a skip.
    log = String(err);
    record = {
      name: spec.name,
      extension: spec.extension,
      status: "failed",
      exitCode: null,
      durationMs: Date.now() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      reason: `could not run ${spec.cmd[0]}: ${err}`,
    };
  }

  await Deno.writeTextFile(`${outDir}/logs/${stem}.log`, log);
  await Deno.writeTextFile(
    `${outDir}/steps/${stem}.json`,
    JSON.stringify(record, null, 2) + "\n",
  );
  return record;
}

/** Runs `jobs` with at most `limit` in flight; results keep input order. */
export async function pool<T>(
  jobs: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, jobs.length)) },
    async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await jobs[i]();
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * The registry quality rubric's pass condition, the same one ci.yml applies:
 * status passed, 100% either directly or once provisional factors are earned,
 * and `allPassed` not explicitly false.
 */
export function judgeQuality(stdout: string): string | null {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(stdout);
  } catch {
    return "swamp extension quality did not return JSON";
  }
  const provisional = r.ifProvisionalEarned as
    | { percentage?: number }
    | undefined;
  const pctOk = r.percentage === 100 || provisional?.percentage === 100;
  if (r.status !== "passed") return `quality status is ${String(r.status)}`;
  if (!pctOk) return `quality is ${String(r.percentage)}%, not 100`;
  if (r.allPassed === false) return "quality allPassed is false";
  return null;
}

/** The four per-extension tasks, for every extension the diff selected. */
export function runExtensionTasks(
  outDir: string,
  repoRoot: string,
  extensions: readonly string[],
  concurrency: number,
): Promise<StepRecord[]> {
  const jobs = extensions.flatMap((ext) =>
    EXTENSION_TASKS.map((task) => () =>
      runRecorded(outDir, {
        name: `${ext}:${task}`,
        extension: ext,
        cmd: ["deno", "task", task],
        cwd: `${repoRoot}/${ext}`,
      })
    )
  );
  return pool(jobs, concurrency);
}

/** `swamp extension fmt manifest.yaml --check` per extension. */
export function runManifestFmt(
  outDir: string,
  repoRoot: string,
  extensions: readonly string[],
  concurrency: number,
): Promise<StepRecord[]> {
  return pool(
    extensions.map((ext) => () =>
      runRecorded(outDir, {
        name: `${ext}:manifest-fmt`,
        extension: ext,
        cmd: ["swamp", "extension", "fmt", "manifest.yaml", "--check"],
        cwd: `${repoRoot}/${ext}`,
      })
    ),
    concurrency,
  );
}

/** The registry quality rubric per extension. Needs the swamp CLI and login. */
export function runQuality(
  outDir: string,
  repoRoot: string,
  extensions: readonly string[],
  concurrency: number,
): Promise<StepRecord[]> {
  return pool(
    extensions.map((ext) => () =>
      runRecorded(outDir, {
        name: `${ext}:quality`,
        extension: ext,
        cmd: ["swamp", "extension", "quality", "manifest.yaml", "--json"],
        cwd: `${repoRoot}/${ext}`,
        judge: judgeQuality,
      })
    ),
    concurrency,
  );
}
