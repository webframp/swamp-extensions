# @webframp/valkey-datastore

Stores swamp runtime data in Valkey or any Redis-compatible backend. Uses a
sorted-set path index for O(log n + k) prefix lookups instead of pattern
scanning, and SET NX with Lua-guarded release for distributed locking.

## Compatibility

- Local Valkey / Redis 7+
- AWS ElastiCache Serverless (Valkey)
- AWS MemoryDB for Valkey
- Any Redis-protocol-compatible server

## Configuration

```yaml
# .swamp.yaml
datastore:
  type: "@webframp/valkey-datastore"
  config:
    url: "redis://localhost:6379"
    prefix: "swamp" # default: "swamp"
    db: 0 # default: 0
```

Or via environment variable:

```bash
export SWAMP_DATASTORE='@webframp/valkey-datastore:{"url":"redis://localhost:6379"}'
```

### TLS (ElastiCache / MemoryDB)

```yaml
datastore:
  type: "@webframp/valkey-datastore"
  config:
    url: "rediss://your-cluster.cache.amazonaws.com:6379"
    tls: true
```

With CA verification:

```yaml
tls:
  ca: "/path/to/ca-bundle.pem"
  rejectUnauthorized: true
```

## Key Schema

All keys are namespaced under the configured prefix:

| Key pattern               | Type             | Purpose                     |
| ------------------------- | ---------------- | --------------------------- |
| `{prefix}:blob:{relPath}` | String           | File content (binary-safe)  |
| `{prefix}:meta:{relPath}` | Hash             | SHA-256, size, deleted flag |
| `{prefix}:_paths`         | Sorted Set       | Lexicographic path index    |
| `{prefix}:_seq`           | String (integer) | Commit sequence counter     |
| `{prefix}:_lock:{key}`    | String           | Distributed lock with TTL   |

The sorted-set path index enables `ZRANGEBYLEX` prefix queries in O(log n + k) —
where n is total paths and k is matching results — instead of O(n) `SCAN` with
glob patterns.

## Distributed Locking

Uses the standard single-instance Redlock pattern:

- Acquire: `SET key value NX PX ttl`
- Heartbeat: periodic `PEXPIRE` refresh while lock is held
- Release: Lua script that checks nonce before `DEL`
- Stale locks expire via TTL if the holder crashes

## Sync Architecture

Implements two-phase sync:

1. **preparePush** — collects local diff and reads file content (outside lock)
2. **commitPush** — pipelines all Valkey writes (fast, under lock)

Single-phase `pushChanged` is also supported for backward compatibility.

Pull uses a sequence counter fast path: if local seq matches remote, no work is
done. Changed files are fetched in batched pipelines.

## Memory Considerations

All data lives in RAM. Best suited for repos with aggressive garbage collection
and moderate data sizes. At 50 models with 10 retained versions averaging 5KB
each, total memory usage is ~3MB. Repos with large outputs or long retention
should prefer S3 or PostgreSQL.

## Observability

The extension emits [OpenTelemetry](https://opentelemetry.io/) spans for Valkey
commands, lock acquisition/release, and push/pull sync. It depends on
`@opentelemetry/api` only — the host process owns the `TracerProvider`, so every
span is a no-op when none is registered. When swamp runs with OTel enabled,
datastore activity appears in traces nested under swamp's own
`swamp.datastore.*` spans.

Three layers are instrumented:

- **Commands** — one span per round trip (`Valkey SET`, `Valkey GET`,
  `Valkey ZRANGEBYLEX`, `Valkey ZSCORE`, `Valkey GETBUFFER`, `Valkey EVAL`,
  `Valkey INCR`, `Valkey PING`, `Valkey INFO`) with `db.system.name`,
  `db.operation.name`, and `valkey.key`. Pipeline flushes get a single span each
  — `Valkey pipeline writeFiles`, `deleteFiles`, `fetchMetadata`, `fetchHashes`
  — carrying `valkey.pipeline.commands`, so a push of a thousand files produces
  a handful of spans rather than three thousand.
- **Lock** — `valkey-datastore lock acquire` / `release` / `withLock` /
  `inspect` / `forceRelease`. Acquire records `lock.wait_duration_ms` and
  `lock.contended`; inspect records `lock.holder`. Heartbeat renewals are
  deliberately not instrumented — a lock held for minutes would otherwise bury
  the trace in periodic `PEXPIRE` spans.
- **Sync** — `valkey-datastore pullChanged` / `pushChanged` / `hydrateFile` /
  `preparePush` / `commitPush`, with `datastore.files_pulled`,
  `datastore.files_pushed`, `datastore.files_deleted`, `datastore.paths`,
  `datastore.truncated`, `datastore.seq`, and `datastore.fast_path_hit`.

Lock contention retries appear as `retry` events on the acquire span, with
`retry.attempt`, `retry.delay_ms`, and `retry.reason`.

Blob values are file content and the connection URL embeds a password. Neither
is recorded; span attributes carry only command names, key names, and counts.

## Troubleshooting

### Lock heartbeat failure is silent — lock expires via TTL

The background heartbeat interval catches all errors silently. If the Redis
connection drops during a long operation, the lock expires after its 30-second
TTL. The holder is not notified. Competing processes can then acquire the lock.

### `PATH_LIMIT = 50,000` hard cap on remote index

If a repository stores more than 50,000 files, full-walk diff and pull
operations throw rather than attempting to load the entire index. Scoped sync
(per-model pull) stays within this limit for typical repositories.

### Dirty paths cap at 1,000 before bulk invalidation

When more than 1,000 files are modified without a push, the sidecar flips to
`bulkInvalidated` mode, forcing a full walk diff. Push frequently in
high-write-rate scenarios to maintain incremental push performance.

### Network errors are not retried

The `maxRetriesPerRequest` setting (default 3) covers command-level retries
within ioredis. Transport-level failures (DNS, TLS handshake) at connection time
propagate immediately. Use `connectTimeoutMs` (default 10s) to control how long
the initial connection waits.

### TLS configuration

Pass `tls: true` for basic TLS or `tls: { ca: "/path/to/ca.pem" }` for custom CA
verification. The CA file is read synchronously at startup — if it is missing or
unreadable, the extension throws immediately.

### Tombstone GC failure is non-fatal

The post-push garbage collection of old tombstones catches all errors silently.
If GC fails, stale tombstone metadata accumulates until the next successful GC
run. Stale clients may perform slower full pulls until GC advances.

### Single Redis connection (no pool)

The extension uses a single ioredis connection with command pipelining. This is
idiomatic for Redis (single-threaded server), but means one slow command blocks
all others. Monitor command latency if you observe sync slowdowns.

## Development

```bash
cd datastore/valkey
deno task check
deno task lint
deno task fmt
deno task test
```
