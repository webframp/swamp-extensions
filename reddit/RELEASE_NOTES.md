## 2026.08.21.1

**Changed:** Tightened `clientId`, `clientSecret`, `username`, `password`,
and `userAgent` on the global-args schema to require non-empty strings. All
five are required OAuth2/account credentials that the Reddit API never
accepts empty — this catches misconfigured vault references or blank
`--global-arg` values at model-create time instead of a confusing API
failure on first method call.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `moderation.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.

## 2026.07.16.1

**Changed:** Internal-only version bump. PR #183 touched `deno.json` (added a `fmt:check` task) and reordered a test-file import, but neither file is part of the published bundle — this release's published content is identical to `2026.06.23.1`.
