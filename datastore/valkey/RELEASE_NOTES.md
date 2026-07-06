## 2026.07.05.3

### Fixed

- Lock `acquire()` assigned nonce before the retry loop; if `redis.set()` threw
  (e.g. ElastiCache failover), nonce was left set, permanently blocking
  re-acquire. Now uses a candidate variable and only promotes to nonce on
  success.
- `pathsForPrefixes` used `charCode + 1` inclusive upper-bound, which could
  match an adjacent path (e.g. `data/foo0` when scanning `data/foo/`). Aligned
  to the 0xFF exclusive sentinel used in `collectOneRelDiff`.
- Removed `RELEASE_NOTES.md` from manifest `additionalFiles` per project policy.
- Aligned `sidecar.ts` `isTraversal("")` to return `true`, matching `mod.ts`
  behavior.

## 2026.07.05.2

### Fixed

- `collectOneRelDiff` used ZRANGEBYLEX prefix range for single-file dirty
  pushes, which over-fetched sibling paths (e.g. v1 matching v10, v11) and
  tombstoned them. Now uses `ZSCORE` point lookup for files; range scan only for
  directories.
- Verifier called `redis.connect()` explicitly, which throws on an
  already-connected client after sync operations. Removed — ioredis lazy connect
  triggers on first command.
- `allPaths()` and `pathsForPrefixes()` were unbounded. Added 50k LIMIT clause
  and truncated flag.
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
