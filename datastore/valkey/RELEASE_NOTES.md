## 2026.07.18.2

**Changed:** Version bump only, no code changes.

## 2026.07.18.1

### Changed

- Pinned the `zod` import specifier to `npm:zod@4.4.3` (was `npm:zod@4`) for
  hermetic dependency resolution. No runtime behavior change.

## 2026.07.05.5

### Fixed

- `collectFullWalkDiff` silently discarded the truncated flag from `allPaths()`,
  causing deletions beyond the 50k cap to be invisible. Now throws when
  truncated, refusing to run an incomplete diff.
- `applyChanges` pipeline errors were silently swallowed — `pipeline.exec()`
  returns per-command `[Error, result]` tuples that were never inspected. Dirty
  state was cleared despite partial write failures. Now inspects every result
  tuple and throws with the list of failed paths.
- `allPaths()` truncation check used a separate `ZCARD` after `ZRANGEBYLEX`
  (TOCTOU race). Replaced with LIMIT+1 pattern: fetch one extra entry and check
  length.
- `createRedisClient` TLS CA read: wrapped `readTextFileSync` with contextual
  error message for missing CA files.

## 2026.07.05.4

### Fixed

- `collectOneRelDiff` still used ZRANGEBYLEX prefix scan when a file was deleted
  locally (`stat === null` fell through to the else branch). Inverted the
  branch: prefix scan only for `stat?.isDirectory`, ZSCORE point lookup for
  everything else (existing files and deleted files).
- `collectOneRelDiff` directory branch had no LIMIT clause — added 50k cap
  matching `allPaths`/`pathsForPrefixes`.
- Removed dead `deleted === "true"` branch in `pullFiles` — `applyChanges`
  hard-deletes via `redis.del`/`zrem`, so no meta with `deleted:true` is ever
  written.

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
