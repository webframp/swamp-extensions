/**
 * Stores attestations as git refs: `refs/attestations/<tree>/<timestamp>`,
 * each pointing at a one-file commit holding `attestation.json`.
 *
 * Keyed by tree hash because a squash merge into an up-to-date base keeps the
 * verified head's tree, while the commit hash changes. Pushes never force, so
 * an existing attestation cannot be overwritten; a re-verification of the same
 * tree writes a new timestamped ref and the newest wins. Only someone who can
 * push to the repository can write one.
 *
 * @module
 */

import { git, gitText } from "./git.ts";
import type { Attestation } from "./types.ts";

export const REF_PREFIX = "refs/attestations";

/** Sortable UTC timestamp with milliseconds, safe inside a ref name. */
export function refTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

export function refFor(tree: string, now: Date): string {
  return `${REF_PREFIX}/${tree}/${refTimestamp(now)}`;
}

/**
 * Writes the attestation as a commit using plumbing, leaving the working tree
 * and index alone, then pushes it to `remote` without force.
 */
export async function postAttestation(
  repoDir: string,
  attestation: Attestation,
  opts: { remote?: string; now?: Date } = {},
): Promise<{ ref: string; commit: string }> {
  const remote = opts.remote ?? "origin";
  const tree = attestation.subject.tree;

  // Refuse an attestation whose claimed tree is not the tree of its commit.
  const actualTree = await gitText(
    ["rev-parse", `${attestation.subject.commit}^{tree}`],
    { cwd: repoDir },
  );
  if (actualTree !== tree) {
    throw new Error(
      `attestation claims tree ${tree} but commit ${attestation.subject.commit} has tree ${actualTree}`,
    );
  }

  const blob = await gitText(["hash-object", "-w", "--stdin"], {
    cwd: repoDir,
    stdin: JSON.stringify(attestation, null, 2) + "\n",
  });
  const dir = await gitText(["mktree"], {
    cwd: repoDir,
    stdin: `100644 blob ${blob}\tattestation.json\n`,
  });
  const commit = await gitText(
    ["commit-tree", dir, "-m", `attestation for tree ${tree}`],
    {
      cwd: repoDir,
      env: {
        GIT_AUTHOR_NAME: "verify",
        GIT_AUTHOR_EMAIL: "verify@localhost",
        GIT_COMMITTER_NAME: "verify",
        GIT_COMMITTER_EMAIL: "verify@localhost",
      },
    },
  );

  const ref = refFor(tree, opts.now ?? new Date());
  const push = await git(["push", remote, `${commit}:${ref}`], {
    cwd: repoDir,
  });
  if (!push.ok) {
    throw new Error(`pushing ${ref} failed: ${push.stderr.trim()}`);
  }
  return { ref, commit };
}

/** Lists attestation refs for a tree on `remote`, oldest first. */
export async function listAttestationRefs(
  repoDir: string,
  tree: string,
  remote = "origin",
): Promise<string[]> {
  const out = await gitText(
    ["ls-remote", remote, `${REF_PREFIX}/${tree}/*`],
    { cwd: repoDir },
  );
  return out.split("\n")
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((r): r is string => !!r)
    .sort();
}

/**
 * Fetches the newest attestation for `tree`, or null when none exists. A
 * malformed document throws: an unreadable attestation must not read as
 * "none posted".
 */
export async function fetchLatestAttestation(
  repoDir: string,
  tree: string,
  remote = "origin",
): Promise<{ ref: string; attestation: Attestation } | null> {
  const refs = await listAttestationRefs(repoDir, tree, remote);
  const ref = refs.at(-1);
  if (!ref) return null;

  const local = "refs/verify/fetched-attestation";
  await gitText(
    ["fetch", "--no-tags", "--depth=1", remote, `+${ref}:${local}`],
    { cwd: repoDir },
  );
  const text = await gitText(["show", `${local}:attestation.json`], {
    cwd: repoDir,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`attestation at ${ref} is not valid JSON`);
  }
  return { ref, attestation: parsed as Attestation };
}
