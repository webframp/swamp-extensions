/**
 * Thin wrapper over the git CLI. Every call returns its outcome instead of
 * throwing, so callers decide whether a failure is fatal.
 *
 * @module
 */

export interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  cwd?: string;
  stdin?: string;
  env?: Record<string, string>;
}

export async function git(
  args: string[],
  opts: GitOptions = {},
): Promise<GitResult> {
  const child = new Deno.Command("git", {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (opts.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  }
  const out = await child.output();
  const dec = new TextDecoder();
  return {
    ok: out.success,
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
}

/** Runs git and returns trimmed stdout, throwing with git's message on failure. */
export async function gitText(
  args: string[],
  opts: GitOptions = {},
): Promise<string> {
  const r = await git(args, opts);
  if (!r.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}
