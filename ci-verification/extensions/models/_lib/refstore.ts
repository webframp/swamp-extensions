// SPDX-License-Identifier: Apache-2.0
/**
 * Stores attestations as git refs: `refs/attestations/<tree>/<timestamp>`, each
 * pointing at a one-file commit holding `attestation.json`.
 *
 * Keyed by tree because a squash merge into an up-to-date base keeps the
 * verified head's tree while the commit changes. Pushes never force, so an
 * existing attestation is never overwritten; verifying the same tree again
 * writes a new timestamped ref, and the newest wins.
 *
 * @module
 */

import { git, gitText } from "./git.ts";
import { refTimestamp } from "./util.ts";

export const REF_PREFIX = "refs/attestations";

const AUTHOR = {
  GIT_AUTHOR_NAME: "ci-verification",
  GIT_AUTHOR_EMAIL: "ci-verification@localhost",
  GIT_COMMITTER_NAME: "ci-verification",
  GIT_COMMITTER_EMAIL: "ci-verification@localhost",
};

export function refFor(tree: string, now: Date): string {
  return `${REF_PREFIX}/${tree}/${refTimestamp(now)}`;
}

/**
 * Writes `document` as a one-file commit with plumbing, leaving the working
 * tree and index alone, and pushes it to `remote` without force. Refuses when
 * `tree` is not `commit`'s tree.
 */
export async function postAttestation(
  repo: string,
  opts: {
    commit: string;
    tree: string;
    document: unknown;
    remote: string;
    now?: Date;
    signal?: AbortSignal;
  },
): Promise<{ ref: string; refCommit: string }> {
  const actual = await gitText(
    repo,
    ["rev-parse", `${opts.commit}^{tree}`],
    opts.signal,
  );
  if (actual !== opts.tree) {
    throw new Error(
      `attestation is for tree ${opts.tree}, but commit ${opts.commit} has tree ${actual}`,
    );
  }
  const blob = await gitText(
    repo,
    ["hash-object", "-w", "--stdin"],
    opts.signal,
    { stdin: JSON.stringify(opts.document, null, 2) + "\n" },
  );
  const dir = await gitText(repo, ["mktree"], opts.signal, {
    stdin: `100644 blob ${blob}\tattestation.json\n`,
  });
  const refCommit = await gitText(
    repo,
    ["commit-tree", dir, "-m", `attestation for tree ${opts.tree}`],
    opts.signal,
    { extraEnv: AUTHOR },
  );
  const ref = refFor(opts.tree, opts.now ?? new Date());
  const push = await git(
    repo,
    ["push", "--", opts.remote, `${refCommit}:${ref}`],
    opts.signal,
  );
  if (!push.ok) {
    throw new Error(
      `pushing ${ref} to ${opts.remote} failed: ${push.log.trim()}`,
    );
  }
  return { ref, refCommit };
}

/** Attestation refs for a tree on `remote`, oldest first. */
export async function listAttestationRefs(
  repo: string,
  tree: string,
  remote: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const out = await gitText(
    repo,
    ["ls-remote", "--", remote, `${REF_PREFIX}/${tree}/*`],
    signal,
  );
  return out.split("\n")
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((r): r is string => !!r)
    .sort();
}
