## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `container_image.ts` for proper
`typeVersion` tracking on existing instances. No schema or behavior changes.

## 2026.07.13.1

**Changed:** Upgraded the test-only dev dependency `@systeminit/swamp-testing`
to `0.20260504.10`, matching the rest of the repo. This is a test-harness change
only — the published extension bundle is unchanged and no runtime behavior is
affected.
