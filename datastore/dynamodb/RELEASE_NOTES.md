## 2026.07.25.1

**Added:** OpenTelemetry spans for every layer of the datastore. Each SDK call
emits one span named for the wire operation (`DynamoDB PutItem`,
`DynamoDB Query`, `DynamoDB BatchWriteItem`, …) carrying
`aws.dynamodb.table_names`, the GSI name when one is used, consumed capacity,
returned and scanned counts, HTTP status, and the AWS request ID. The lock
emits `dynamodb-datastore lock acquire` / `release` / `withLock` / `inspect` /
`forceRelease`, with acquire recording wait duration and whether it contended.
The sync service emits `dynamodb-datastore pullChanged` / `pushChanged` /
`hydrateFile` / `preparePush` / `commitPush` with file counts, chunk counts,
and fast-path indicators.

**Added:** Control-plane calls are covered too. `DescribeTable`, `CreateTable`,
and `UpdateTimeToLive` go through the low-level client rather than the document
client, so both clients are instrumented — table creation and health checks are
no longer invisible.

**Added:** Retries are recorded as `retry` span events on the enclosing
operation. This covers the throttling backoff in `retryable`, the
`UnprocessedKeys` loop in `BatchGetItem`, and the `UnprocessedItems` loop in
`BatchWriteItem` — the latter two retry independently of the shared helper and
previously left no trace of partial throttling at all.

**Changed:** Nothing observable without tracing configured. The extension
depends on `@opentelemetry/api` only; the host process owns the
TracerProvider, and every span is a no-op when none is registered. Existing
behaviour, return values, and log output are unchanged.

**Note:** Item content is never recorded as a span attribute — only counts,
key names, and table/index names.
