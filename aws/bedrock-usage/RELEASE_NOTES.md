## 2026.08.21.1

**Changed:** CloudWatch API failures during `scan_accounts`, `get_token_usage`,
and `list_active_models` now raise an error naming the failing operation
(`ListMetrics`, `GetMetricData`) along with the profile, region, and — where
applicable — the model ID being queried. Previously these calls surfaced the
raw AWS SDK error with no indication of which account, region, or metric
request had failed.

**Changed:** The `profiles` and `regions` global arguments now require at
least one non-empty entry each. Previously an empty array silently produced
a no-op scan instead of a clear validation error.
