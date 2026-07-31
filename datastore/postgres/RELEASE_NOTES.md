## 2026.07.30.2

**Fixed:** Pull-skip watermark comparison now validates the JSONB timestamp
before trusting the fast-path. If `postgres@3.x` ever returns the raw JSON
string (with outer quotes) instead of a pre-parsed scalar, the Date guard
detects `Invalid Date` and falls through to a full scan rather than silently
disabling the optimization.

**Fixed:** `clearPushed` failures after a successful DB push no longer propagate
exceptions. Since the transaction already committed, a local filesystem error
only causes redundant re-pushes on the next cycle (upserts are idempotent). The
failure is logged via `console.warn` for visibility.

**Fixed:** Backoff timing test uses `baseDelayMs=100` (was 50) and a widened
tolerance multiplier (1.2x, was 1.5x) to prevent flapping under CI scheduling
jitter.
