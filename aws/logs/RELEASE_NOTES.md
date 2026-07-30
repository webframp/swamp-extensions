## 2026.07.30.2

**Fixed:** The `query` and `find_errors` methods now fail when a Logs Insights query
does not reach `Complete` status. Previously, a timed-out query (status `Running`) or
a terminal failure (`Failed`/`Cancelled`) was stored as a successful result with zero
rows, misleading downstream consumers.

**Added:** `requireComplete` argument on the `query` method (default `true`). Set to
`false` to store partial/incomplete results without error — useful for callers that
inspect the `status` field themselves.

**Changed:** When a query times out with `requireComplete: true`, the method cancels
the in-progress query via `StopQuery` before throwing, preventing orphaned scans from
continuing to consume resources.
