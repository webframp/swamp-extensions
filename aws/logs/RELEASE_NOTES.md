## 2026.08.20.1

**Changed:** Bump @aws-sdk/* 3.1111.0 → 3.1114.0 (2 packages)

## 2026.08.15.1

**Changed:** Bump @aws-sdk/* 3.1104.0 → 3.1111.0 (2 packages)

## 2026.08.05.1

**Changed:** Bump @aws-sdk/* 3.1101.0 → 3.1104.0 (2 packages)

## 2026.08.02.1

**Changed:** Bump @aws-sdk/* 3.1100.0 → 3.1101.0 (2 packages)

## 2026.08.01.1

**Fixed:** Broken model-upgrade chain. The prior version bump (to `2026.07.31.1`) updated `version` but left the `upgrades` array terminating one step short, which blocks `swamp extension push` ("model upgrade chain errors"). That version never actually published — the registry was still serving `2026.07.30.2`. This release closes the chain with a no-op upgrade entry and republishes everything that had accumulated since `2026.07.30.2`.

## 2026.07.31.1

**Changed:** Bump @aws-sdk/* 3.1096.0 → 3.1100.0 (2 packages)

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
