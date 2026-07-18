## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `moderation.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.

## 2026.07.16.1

**Changed:** Internal-only version bump. PR #183 touched `deno.json` (added a `fmt:check` task) and reordered a test-file import, but neither file is part of the published bundle — this release's published content is identical to `2026.06.23.1`.
