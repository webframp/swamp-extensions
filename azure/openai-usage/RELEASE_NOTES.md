## 2026.08.23.1

**Changed:** Documentation only — no code changes. Expanded thin method
descriptions with concrete examples. Added a `## Troubleshooting` section
covering the silent zero-usage drop from `scan_subscriptions`, the
independent `deploymentBreakdownFailed` degrade path, overloaded `truncated`
semantics across subscription/resource scan failures, the `getAccessToken`
client-credentials failure format, and a Reader-role permission gap where
discovery can succeed and metrics 403 — and 403s aren't retried, since
`fetchWithRetry` only retries 429/5xx.
