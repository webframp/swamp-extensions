## 2026.08.21.1

**Changed:** Added descriptions to the previously undocumented fields across
the `health`, `repos`, `packages`, `package-diff`, and `storage` resource
schemas, and to the `diff_packages` method's `limit` argument. Tightened the
global `token` argument to require a non-empty string.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `artifactory.ts` for proper
`typeVersion` tracking on existing instances. No schema or behavior changes.
