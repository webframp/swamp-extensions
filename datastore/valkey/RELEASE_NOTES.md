## 2026.07.05.2

### Fixed

- `collectOneRelDiff` used ZRANGEBYLEX prefix range for single-file dirty pushes, which over-fetched sibling paths (e.g. v1 matching v10, v11) and tombstoned them. Now uses `ZSCORE` point lookup for files; range scan only for directories.
- Verifier called `redis.connect()` explicitly, which throws on an already-connected client after sync operations. Removed — ioredis lazy connect triggers on first command.
- `allPaths()` and `pathsForPrefixes()` were unbounded. Added 50k LIMIT clause and truncated flag.
- Pinned zod to exact version (4.4.3) in deno.json.

### Added

- `RELEASE_NOTES.md` for CI publish workflow.
- Regression test: verifier works after sync operation (double-connect).

## 2026.07.05.1

### Added

- Valkey/Redis datastore extension for swamp
- Sorted-set path index (`ZRANGEBYLEX`) for O(log n + k) prefix lookups
- SET NX with Lua-guarded release for distributed locking
- Two-phase sync (`preparePush`/`commitPush`) to minimize time under global lock
- Sidecar dirty-path tracking with sequence-counter fast path for pull
- TLS support for AWS ElastiCache Serverless and MemoryDB
- Configurable key prefix, database number, connection timeout, and retry limits
