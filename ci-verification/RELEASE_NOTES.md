## 2026.11.12.1

**Added:** Initial release. A model, `@webframp/ci-verification`, that runs the
checks swamp-extensions CI runs against one commit and records every result and
its log as swamp data, keyed by the commit's tree hash:

- `discover` records which extensions and repo-wide checks the diff selects,
  using the commit's own `scripts/ci-discover`.
- `check` runs each selected extension's check, lint, fmt:check, test and
  manifest fmt, plus the reserved data name scan, the import specifier greps and
  the tasks of each touched `scripts/` tool.
- `quality` runs `swamp extension quality` under CI's pass condition.
- `attest` builds an attestation from the recorded results and refuses if any
  result is missing, failed, or stale, or if the change touches the trust root
  (ci-discover, check-reserved-names, this extension, CI workflows) and no
  approval was given.
- `post` pushes the attestation to `refs/attestations/<tree>/<timestamp>`, never
  forced.

Every method runs in a throwaway worktree at the commit, with an allowlisted
environment for child processes. A rerun reuses passed results and reruns failed
ones.

**Added:** The `@webframp/ci-verification-verify` workflow, which runs discover,
check and quality in sequence.
