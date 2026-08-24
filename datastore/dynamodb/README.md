# @webframp/dynamodb-datastore

Stores swamp runtime data in AWS DynamoDB using a single-table design, with
conditional-write distributed locking and chunked blob storage for items over
DynamoDB's 400KB size limit.

## Features

- **Conditional-write distributed locking** with fencing-token nonces —
  `PutItem`/`UpdateItem`/`DeleteItem` conditional expressions provide the same
  compare-and-swap safety as the postgres/valkey datastores
- **TTL as defense-in-depth, not correctness** — the native DynamoDB `ttl`
  attribute exists only to eventually garbage-collect abandoned lock items;
  `acquire()` always does an explicit client-computed staleness check, since
  DynamoDB's TTL sweep can lag up to 48h
- **Serverless, zero-ops** — no server to provision or patch; pay-per-request
  billing scales to zero
- **Chunked blob storage** — files over `maxChunkBytes` are split across
  multiple items and reassembled on read, working around DynamoDB's per-item
  size ceiling
- **DynamoDB Local support** — `endpoint` config field for local development and
  CI without touching live AWS

## Configuration

```yaml
# .swamp.yaml
datastore:
  type: "@webframp/dynamodb-datastore"
  config:
    region: "us-east-1" # default: "us-east-1"
    tableName: "swamp-datastore" # default: "swamp-datastore"
    # endpoint: "http://localhost:8000"  # DynamoDB Local only — leave unset for production
    # autoCreateTable: false             # default: false — see "Required Schema" below
    # maxChunkBytes: 262144              # default: 256KB
```

Or via environment variable:

```bash
export SWAMP_DATASTORE='@webframp/dynamodb-datastore:{"tableName":"swamp-datastore","region":"us-east-1"}'
```

No credentials are accepted in config. This extension uses the AWS SDK's default
credential provider chain (environment variables, shared config/ profile, or an
attached IAM role) — the same convention as every other `@webframp/aws/*`
extension in this repo.

## Required Schema

DynamoDB tables are not auto-created by default (`autoCreateTable: false`) —
provision the table via IaC before first use:

- **Partition key:** `pk` (String)
- **Sort key:** `sk` (String)
- **TTL attribute:** `ttl` (Number, epoch seconds) — enable DynamoDB's native
  TTL on this attribute; it is defense-in-depth cleanup only, never relied on
  for lock correctness
- **Billing mode:** `PAY_PER_REQUEST` recommended
- **Global secondary index** `gsi1` — partition key `gsi1pk` (String), sort key
  `gsi1sk` (String), projection `ALL` — used for cheap `Query`-based full-walk
  diffs and prefix-scoped sync during sync instead of a table `Scan`. Only
  file-metadata items carry `gsi1pk`/`gsi1sk` attributes; lock items and file
  chunks are excluded from the index automatically, so `ALL` projection never
  leaks chunk content into the index.

Set `autoCreateTable: true` to have the extension create the table (with the
above schema, TTL, and GSI) on first use — convenient for local development, but
production tables should be provisioned via IaC so table creation isn't gated on
IAM permissions the runtime credential may not have.

### Item layout (single table)

| Item           | `pk`               | `sk`            | Notes                                                         |
| -------------- | ------------------ | --------------- | ------------------------------------------------------------- |
| Lock           | `LOCK#<key>`       | `LOCK`          | `nonce`, `acquiredAtMs`, `expiresAtMs`, `ttl`                 |
| File metadata  | `FILE#<relPath>`   | `META`          | `hash`, `size`, `chunkCount`, `updatedAt`, `gsi1pk`, `gsi1sk` |
| File chunk     | `FILE#<relPath>`   | `CHUNK#0000`... | `content` (Binary)                                            |
| Sync watermark | `SYNCSTATE#global` | `STATE`         | `lastPushedAt`                                                |

## Required IAM Permissions

- `dynamodb:GetItem`
- `dynamodb:PutItem`
- `dynamodb:UpdateItem`
- `dynamodb:DeleteItem`
- `dynamodb:Query`
- `dynamodb:BatchWriteItem`
- `dynamodb:DescribeTable`
- `dynamodb:CreateTable` (only if `autoCreateTable: true`)

## DynamoDB Local (development)

```bash
docker run -p 8000:8000 amazon/dynamodb-local
```

```yaml
datastore:
  type: "@webframp/dynamodb-datastore"
  config:
    tableName: "swamp-datastore"
    endpoint: "http://localhost:8000"
    autoCreateTable: true
```

## Observability

The extension emits [OpenTelemetry](https://opentelemetry.io/) spans for
DynamoDB operations, lock acquisition/release, and push/pull sync. It depends on
`@opentelemetry/api` only — the host process owns the `TracerProvider`, so every
span is a no-op when none is registered. When swamp runs with OTel enabled,
datastore activity appears in traces nested under swamp's own
`swamp.datastore.*` spans.

Three layers are instrumented:

- **SDK calls** — one span per request, named for the wire operation
  (`DynamoDB PutItem`, `DynamoDB Query`, `DynamoDB BatchWriteItem`, …) with
  `aws.dynamodb.table_names`, `aws.dynamodb.index_name`,
  `aws.dynamodb.consumed_capacity.total`, `aws.dynamodb.count`,
  `aws.dynamodb.scanned_count`, `http.response.status_code`, and
  `aws.request_id`. Both the document client and the low-level client are
  wrapped, so control-plane calls (`DescribeTable`, `CreateTable`,
  `UpdateTimeToLive`) are covered as well.
- **Lock** — `dynamodb-datastore lock acquire` / `release` / `withLock` /
  `inspect` / `forceRelease`. Acquire records `lock.wait_duration_ms` and
  `lock.contended`; inspect records `lock.holder`. Heartbeat renewals are
  deliberately not given their own span — a lock held for minutes would
  otherwise bury the trace in periodic noise.
- **Sync** — `dynamodb-datastore pullChanged` / `pushChanged` / `hydrateFile` /
  `preparePush` / `commitPush`, with `datastore.files_pulled`,
  `datastore.files_pushed`, `datastore.files_deleted`, `datastore.chunks`, and
  `datastore.fast_path_hit`.

Retries appear as `retry` events on the enclosing span, with `retry.attempt`,
`retry.delay_ms`, and `retry.reason` — `retryable_error` for throttling backoff,
`unprocessed_keys` for `BatchGetItem` partial results, and `unprocessed_items`
for `BatchWriteItem` partial writes. The last two matter because
`BatchWriteItem` does not throw on partial throttling; it silently returns the
items it skipped.

Item content is never recorded. Span attributes carry counts, key names, and
table or index names only.

## Troubleshooting

### Lock heartbeat and release failures are silent

Both the background heartbeat renewal and the `release()` method catch all
errors silently. If the DynamoDB connection is lost, the lock expires via its
TTL (30s default). DynamoDB's TTL sweep has up to a 1-hour buffer, but the
`expiresAtMs` conditional check provides immediate staleness detection.

### No `profile` in datastore config — use `AWS_PROFILE` env var

The extension's config schema does not accept a `profile` field. AWS credential
selection happens via the SDK's default provider chain. Set `AWS_PROFILE`
externally before running swamp commands if you need a specific profile.

### `autoCreateTable` requires additional IAM permissions

When `autoCreateTable: true`, the extension needs `dynamodb:CreateTable`,
`dynamodb:DescribeTable`, and `dynamodb:UpdateTimeToLive` in addition to the
standard read/write permissions. Table creation waits up to 60 seconds for
ACTIVE status.

### Chunk cleanup failure leaks storage (non-fatal)

When a file is updated, old version chunks are deleted asynchronously. If
deletion fails (throttling, permission), stale chunks persist in DynamoDB but
are invisible to readers (new metadata points to the new version). Storage waste
accumulates until manual cleanup.

### `BatchWriteItem` unprocessed items retried up to 8 times

DynamoDB can return unprocessed items on throttling without throwing. The
extension retries with exponential backoff (500ms base, 5s cap). After 8
attempts, any remaining unprocessed items cause a hard failure.

### Dirty paths cap at 1,000 before bulk invalidation

When more than 1,000 files are modified without a push, the sidecar forces a
full-walk diff on the next push. Push frequently to avoid hitting this cap.

### `maxChunkBytes` defaults to 256KB (max 300KB)

DynamoDB items are limited to 400KB. The chunk size must account for metadata
overhead. The default of 256KB provides safe headroom. Increasing beyond 300KB
is rejected by validation.

### Retryable error codes

The retry utility handles: `ProvisionedThroughputExceededException`,
`ThrottlingException`, `RequestLimitExceeded`, `InternalServerError`,
`LimitExceededException`, plus system codes (`ECONNRESET`, `ECONNREFUSED`,
`ETIMEDOUT`, `EPIPE`). Other errors fail immediately.

## Development

```bash
cd datastore/dynamodb
deno task check
deno task lint
deno task fmt
deno task test

# Integration tests (requires DynamoDB Local)
docker run -p 8000:8000 amazon/dynamodb-local
DYNAMODB_TEST_ENDPOINT="http://localhost:8000" deno task test
```
