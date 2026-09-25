## 2026.09.24.2

**Changed:** Bump @aws-sdk/* 3.1133.0 → 3.1139.0 (2 packages)

## 2026.09.24.1

**Fixed:** `query` silently stopped at 10,000 rows. `GetQueryResults` returns at
most 10,000 rows per call and the rest via `nextToken`, which was ignored, so a
larger result looked complete. `query` (and `find_errors`) now follow
`nextToken`, bounded at 11 pages.

**Fixed:** A `queryString` over 10,000 characters (StartQuery's cap) now fails
argument validation before any query is started.

**Added:** Optional `limit` argument on `query` (1-100,000), passed to
StartQuery. Without it the API default applies, which is easy to mistake for a
small result.

**Added:** Optional `instanceName` argument on `query`, so a workflow can
address the result with `data.latest(...)` instead of the query hash.

**Added:** Optional `limit` and `truncated` fields on `query_results`.
`truncated` is `true` when the row limit was reached or pagination was capped,
`false` when a limit was set and not reached, and `null` when no limit was
passed.

**Changed:** `query` results that previously ended at 10,000 rows now contain
every row, up to `limit`. Stored resources from earlier versions remain valid:
the new fields are optional.
