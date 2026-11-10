# verification

A swamp repo holding the `verify` workflow, which checks a commit before a pull
request opens and records the result as an attestation. This directory is the
one intentional swamp repo outside the extensions; see "Pre-PR Verification" in
the root `CLAUDE.md` for how to run it and what CI does with the result.

- `workflows/workflow-verify.yaml` runs, in a fresh `git worktree` at the
  verified commit: `ci-discover` (which extensions the diff touches), the four
  per-extension `deno task`s, the manifest format check, the registry quality
  rubric, and the reserved-data-name scan. It then assembles the attestation.
- The workflow is a thin wrapper. The logic lives in `scripts/verify`, which has
  its own tests and runs in CI's `scripts-check` matrix.
- Run it from this directory. Its datastore is local (`.swamp/`, ignored), so no
  cloud credentials are involved. The quality step needs a logged-in `swamp`.
