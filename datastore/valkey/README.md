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

## Development

```bash
cd datastore/valkey
deno task check
deno task lint
deno task fmt
deno task test
```
