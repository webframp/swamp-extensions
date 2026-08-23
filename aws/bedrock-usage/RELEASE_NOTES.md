## 2026.08.23.1

**Changed:** Documentation only — no code changes. Added a `## Troubleshooting`
section covering the silent zero-usage skip in `scan_accounts` (doesn't set
`truncated`), the `regions` global-arg default (`us-east-1`, `us-west-2` only),
overloaded `truncated` semantics across pagination and per-model metric-fetch
failures, and `accountId` always being `null` by design.
