## 2026.07.30.1

**Fixed:** Lock contention on back-to-back model operations. Previously all
lock paths mapped to a single GitLab Terraform state (`{prefix}--lock`),
causing the second operation's sync push to time out waiting for the first to
release. Locks are now per-path — each datastore path gets its own lock state
(`{prefix}--lock--{sanitized-path}`), eliminating cross-model contention
entirely.

**Changed:** Default lock timing constants tuned for actual push latency.
TTL reduced from 30s to 10s, retry interval from 1s to 500ms, max wait from
60s to 30s. Stale lock detection remains at 60s (threshold is now configurable
via `staleLockThresholdMs` and decoupled from TTL).

**Upgrade note:** Existing locks held under the old single-state name
(`{prefix}--lock`) will not conflict with the new per-path names. No migration
required — old lock states become orphaned and can be cleaned up via the GitLab
Terraform states UI if desired.
