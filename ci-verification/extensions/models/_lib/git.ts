// SPDX-License-Identifier: Apache-2.0
/**
 * git operations for verification: resolving the commit once, reading trees,
 * and the throwaway worktree every method runs in.
 *
 * @module
 */

import { childEnv, run, type RunResult } from "./exec.ts";

/** Prefix of every throwaway worktree, so stale ones can be found and removed. */
export const WORKTREE_PREFIX = "ci-verification-wt-";

const SHA = /^[0-9a-f]{40}$/;

export async function git(
  repo: string,
  args: string[],
  signal?: AbortSignal,
  opts: { stdin?: string; extraEnv?: Record<string, string> } = {},
): Promise<RunResult> {
  return await run({
    cmd: "git",
    args,
    cwd: repo,
    env: { ...childEnv("git"), ...(opts.extraEnv ?? {}) },
    signal,
    stdin: opts.stdin,
  });
}

/** git, returning trimmed stdout and throwing with git's message on failure. */
export async function gitText(
  repo: string,
  args: string[],
  signal?: AbortSignal,
  opts: { stdin?: string; extraEnv?: Record<string, string> } = {},
): Promise<string> {
  const r = await git(repo, args, signal, opts);
  if (!r.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${r.log.trim()}`);
  }
  return r.stdout.trim();
}

/** Refuses a repoPath that is not an absolute path to an existing directory. */
export async function checkRepoPath(repoPath: string): Promise<void> {
  if (!repoPath.startsWith("/")) {
    throw new Error(`repoPath must be absolute, got "${repoPath}"`);
  }
  const info = await Deno.stat(repoPath).catch(() => null);
  if (!info?.isDirectory) {
    throw new Error(`repoPath is not a directory: ${repoPath}`);
  }
}

/**
 * Resolves a commit argument once, to a full sha. `--end-of-options` keeps an
 * argument starting with "-" from being read as an option.
 */
export async function resolveCommit(
  repo: string,
  arg: string,
  signal?: AbortSignal,
): Promise<string> {
  const sha = await gitText(
    repo,
    ["rev-parse", "--verify", "--end-of-options", `${arg}^{commit}`],
    signal,
  );
  if (!SHA.test(sha)) throw new Error(`"${arg}" did not resolve to a commit`);
  return sha;
}

export async function treeOf(
  repo: string,
  commit: string,
  signal?: AbortSignal,
): Promise<string> {
  return await gitText(repo, ["rev-parse", `${commit}^{tree}`], signal);
}

export async function isAncestor(
  repo: string,
  base: string,
  commit: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const r = await git(
    repo,
    ["merge-base", "--is-ancestor", base, commit],
    signal,
  );
  return r.ok;
}

/** Files the change touches: the three-dot diff from the merge base. */
export async function changedFiles(
  repo: string,
  base: string,
  commit: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const out = await gitText(
    repo,
    ["diff", "--name-only", "--no-renames", `${base}...${commit}`],
    signal,
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** A throwaway worktree older than this belongs to no live run. */
export const STALE_WORKTREE_MS = 6 * 60 * 60 * 1000;

/**
 * Removes throwaway worktrees a killed run left behind, then prunes git's
 * records of any whose directory is gone. Only worktrees older than
 * STALE_WORKTREE_MS are removed, so a concurrent verification of another commit
 * keeps its own.
 */
export async function removeStaleWorktrees(
  repo: string,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<void> {
  const list = await git(repo, ["worktree", "list", "--porcelain"], signal);
  if (list.ok) {
    for (const line of list.stdout.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const path = line.slice("worktree ".length);
      const name = path.split("/").at(-1) ?? "";
      if (!name.startsWith(WORKTREE_PREFIX)) continue;
      const info = await Deno.stat(path).catch(() => null);
      const age = info?.mtime ? now - info.mtime.getTime() : Infinity;
      if (age > STALE_WORKTREE_MS) {
        await git(repo, ["worktree", "remove", "--force", path], signal);
      }
    }
  }
  await git(repo, ["worktree", "prune"], signal);
}

/**
 * Runs `fn` in a fresh detached worktree at `commit`, removed afterwards even
 * when `fn` throws or the signal aborts.
 */
export async function withWorktree<T>(
  repo: string,
  commit: string,
  signal: AbortSignal | undefined,
  fn: (worktree: string) => Promise<T>,
): Promise<T> {
  await removeStaleWorktrees(repo, signal);
  const parent = await Deno.makeTempDir({ prefix: WORKTREE_PREFIX });
  const worktree = `${parent}/${WORKTREE_PREFIX}${commit.slice(0, 12)}`;
  try {
    await gitText(
      repo,
      ["worktree", "add", "--detach", worktree, commit],
      signal,
    );
    return await fn(worktree);
  } finally {
    // Not given the signal: cleanup has to run after an abort too.
    await git(repo, ["worktree", "remove", "--force", worktree]);
    await git(repo, ["worktree", "prune"]);
    await Deno.remove(parent, { recursive: true }).catch(() => {});
  }
}

/** A throwaway HOME for task commands, removed afterwards. */
export async function withTempHome<T>(
  fn: (home: string) => Promise<T>,
): Promise<T> {
  const home = await Deno.makeTempDir({ prefix: "ci-verification-home-" });
  try {
    return await fn(home);
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
}
