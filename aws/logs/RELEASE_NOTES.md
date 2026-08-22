## 2026.08.21.2

**Changed:** CloudWatch Logs API failures now say which operation was
attempted and with what log group(s)/query, instead of surfacing the raw SDK
error. `DescribeLogGroups`, `StartQuery` (in both `query` and `find_errors`),
`GetQueryResults` (during polling), and `FilterLogEvents` failures all raise
a clear error naming the log group(s) or prefix involved, with the original
SDK error preserved as the cause. A `StartQuery` call that returns no
`queryId` also now names the log groups involved instead of a bare "failed
to start query" message.

The `query` method's `logGroupNames` and `queryString` arguments now reject
empty input at the schema level — previously an empty log group list or
query string would only fail deep inside the CloudWatch Logs API with a
generic error.

No schema changes.

## 2026.08.21.1

**Changed:** Tightened `find_errors`'s `logGroupNames` and `get_recent_events`'s
`logGroupName` to require non-empty values — these are required identifiers the
CloudWatch Logs API already rejects when empty.
