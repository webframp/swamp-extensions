## 2026.07.29.1

**Added:** Parallel push writes with bounded concurrency (10 concurrent
`writeFileEntry` calls). Reduces push latency 5-10x for bulk operations.

**Added:** Atomic `commitSeq` counter via DynamoDB `UpdateItem ADD`. Pull
fast-path now compares a monotonic integer instead of parsing ISO timestamps,
eliminating clock-skew vulnerabilities. The sidecar persists `lastPulledSeq`
for fast-path comparison across sessions.

**Changed:** Pull captures `remoteSeq` before partition queries (not after)
to prevent TOCTOU races where concurrent pushes during the fetch window could
be silently missed.

**Changed:** FakeDynamoTable test double handles numeric `ADD` operations and
throws on undefined ExpressionAttributeValues references.

## 2026.07.27.1

**Changed:** Bump @aws-sdk/* 3.1094.0 → 3.1096.0 (2 packages)

**Changed:** Bump @opentelemetry/api 1.9.0 → 1.9.1

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

**Changed:** `pullChanged` reports `datastore.files_pulled` and
`datastore.files_deleted` separately. The internal pull counter increments for
both a downloaded file and a local file removed by a remote tombstone, so
reporting it as a pull count would have overstated downloads.

**Changed:** Nothing observable without tracing configured. The extension
depends on `@opentelemetry/api` only; the host process owns the
TracerProvider, and every span is a no-op when none is registered. Existing
behaviour, return values, and log output are unchanged.

**Note:** Item content is never recorded as a span attribute — only counts,
key names, and table/index names.

**Note:** Span names are resolved from the SDK command's class identity rather
than `constructor.name`, so they survive any minification the bundler applies.
Lock heartbeat renewals run detached from the acquiring span, so a renewal is
its own trace instead of a child of an already-ended `lock acquire` span.
