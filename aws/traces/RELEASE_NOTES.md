## 2026.08.21.1

**Changed:** X-Ray API failures now surface with the operation and query
context instead of a bare SDK error. `GetServiceGraph` and `GetTraceSummaries`
calls in `get_service_graph`, `get_traces`, `get_errors`, and `analyze_errors`
now catch failures and rethrow with the group name, filter expression, or
error type that was in flight, plus the original error preserved as `cause`.

`get_service_graph`, `get_traces`, and `get_errors` previously paginated with
no page cap — a query that kept returning a `NextToken` could loop
indefinitely. All three now stop after 20 pages and set a new `truncated`
field so callers know when results are incomplete instead of silently getting
a partial page with no signal.

`get_traces` and `get_errors` also previously accepted any `limit` value,
including 0 or unbounded numbers; `limit` is now constrained to 1-1000.

## 2026.08.20.1

**Changed:** Bump @aws-sdk/* 3.1111.0 → 3.1114.0 (2 packages)

## 2026.08.15.1

**Changed:** Bump @aws-sdk/* 3.1104.0 → 3.1111.0 (2 packages)

## 2026.08.05.1

**Changed:** Bump @aws-sdk/* 3.1101.0 → 3.1104.0 (2 packages)

## 2026.08.02.1

**Changed:** Bump @aws-sdk/* 3.1100.0 → 3.1101.0 (2 packages)

## 2026.08.01.1

**Fixed:** Broken model-upgrade chain. The prior version bump (to `2026.07.31.1`) updated `version` but left the `upgrades` array terminating one step short, which blocks `swamp extension push` ("model upgrade chain errors"). That version never actually published — the registry was still serving `2026.07.30.1`. This release closes the chain with a no-op upgrade entry and republishes everything that had accumulated since `2026.07.30.1`.

## 2026.07.31.1

**Changed:** Bump @aws-sdk/* 3.1096.0 → 3.1100.0 (2 packages)

## 2026.07.30.1

**Added:** Optional `profile` global argument for multi-account credential resolution.
When set, credentials resolve via `fromIni` (supports SSO token cache and shared-config
profiles). When omitted, the default credential chain applies as before. Fully backward
compatible — no changes required for existing instances.

