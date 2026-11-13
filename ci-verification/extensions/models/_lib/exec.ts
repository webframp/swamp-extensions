// SPDX-License-Identifier: Apache-2.0
/**
 * Runs child processes for verification with an allowlisted environment, an
 * abort signal, and a capped log.
 *
 * Code under test (extension tests, the repository's own scripts) runs in
 * these children, so the environment they see is built from an allowlist, never
 * inherited: cloud credentials, datastore configuration and swamp tokens do not
 * reach them unless the command kind needs one.
 *
 * @module
 */

/** What a child process runs, which decides the environment it gets. */
export type CommandKind =
  /** deno tasks and scripts from the commit under test: a throwaway HOME. */
  | "task"
  /** The swamp CLI: the real HOME (its login) and swamp tokens. */
  | "swamp"
  /** git, including pushes over ssh: the real HOME and the ssh agent. */
  | "git";

const BASE_KEYS = ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"];

/** TLS and proxy settings a network call may need on this host. */
const NETWORK_KEYS = [
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NIX_SSL_CERT_FILE",
  "DENO_CERT",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
];

const KIND_KEYS: Record<CommandKind, string[]> = {
  task: [...BASE_KEYS, ...NETWORK_KEYS],
  swamp: [
    ...BASE_KEYS,
    ...NETWORK_KEYS,
    "HOME",
    "SWAMP_API_KEY",
    "SWAMP_SIGNIN_TOKEN",
  ],
  git: [...BASE_KEYS, ...NETWORK_KEYS, "HOME", "SSH_AUTH_SOCK"],
};

export interface EnvOptions {
  /** The throwaway HOME for task commands. Required for kind "task". */
  taskHome?: string;
  /** The Deno cache directory, kept when HOME changes. */
  denoDir?: string;
  /** The environment to pick from; defaults to this process's. */
  source?: Record<string, string>;
}

/**
 * The environment for one kind of command: only allowlisted keys from the
 * source, plus HOME and DENO_DIR set explicitly where the kind needs them.
 */
export function childEnv(
  kind: CommandKind,
  opts: EnvOptions = {},
): Record<string, string> {
  const source = opts.source ?? Deno.env.toObject();
  const env: Record<string, string> = {};
  for (const key of KIND_KEYS[kind]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  if (kind === "task") {
    if (!opts.taskHome) {
      throw new Error("a task command needs a throwaway HOME");
    }
    env.HOME = opts.taskHome;
  }
  if (opts.denoDir) env.DENO_DIR = opts.denoDir;
  return env;
}

/** The allowlisted keys for a kind, for tests and documentation. */
export function allowedKeys(kind: CommandKind): readonly string[] {
  return KIND_KEYS[kind];
}

/** Logs larger than this keep their last bytes, marked truncated. */
export const MAX_LOG_BYTES = 256 * 1024;

export interface RunSpec {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  maxLogBytes?: number;
  /** Written to the child's stdin, then closed. */
  stdin?: string;
}

export interface RunResult {
  /** True only when the process started and exited 0. */
  ok: boolean;
  /** Exit code, or null when the process could not start. */
  code: number | null;
  /** stdout, kept whole for callers that parse it. */
  stdout: string;
  /** stdout then stderr, capped. */
  log: string;
  /** True when the log was cut to fit the cap. */
  truncated: boolean;
  durationMs: number;
}

/** Keeps the last `max` bytes of a log, where failures usually are. */
export function capLog(
  text: string,
  max = MAX_LOG_BYTES,
): { log: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return { log: text, truncated: false };
  // Decoding a cut that lands inside a character replaces it; that is fine
  // for a log, and the flag says the log is partial.
  const tail = new TextDecoder().decode(bytes.subarray(bytes.length - max));
  return { log: tail, truncated: true };
}

/**
 * Runs one command. Never throws for the command's own failure: a non-zero exit
 * and a process that cannot start are both results with ok false. Throws only
 * when the signal has been aborted, so a cancelled run stops.
 */
export async function run(spec: RunSpec): Promise<RunResult> {
  const started = Date.now();
  spec.signal?.throwIfAborted();
  let out: Deno.CommandOutput;
  try {
    const child = new Deno.Command(spec.cmd, {
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      clearEnv: true,
      stdin: spec.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      signal: spec.signal,
    }).spawn();
    if (spec.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(spec.stdin));
      await writer.close();
    }
    out = await child.output();
  } catch (err) {
    spec.signal?.throwIfAborted();
    const message = `could not run ${spec.cmd}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return {
      ok: false,
      code: null,
      stdout: "",
      log: message,
      truncated: false,
      durationMs: Date.now() - started,
    };
  }
  spec.signal?.throwIfAborted();
  const dec = new TextDecoder();
  const stdout = dec.decode(out.stdout);
  const capped = capLog(stdout + dec.decode(out.stderr), spec.maxLogBytes);
  return {
    ok: out.success,
    code: out.code,
    stdout,
    log: capped.log,
    truncated: capped.truncated,
    durationMs: Date.now() - started,
  };
}
