## 2026.07.18.1

**Changed:** Pinned the `zod` import specifier to `npm:zod@4.4.3` (was
`npm:zod@4`) for hermetic dependency resolution. No runtime behavior change.

## 2026.07.13.1

**Changed:** Upgraded the test-only dev dependency
`@systeminit/swamp-testing` to `0.20260504.10`, matching the rest of the repo.
This is a test-harness change only — the published extension bundle is
unchanged and no runtime behavior is affected.
