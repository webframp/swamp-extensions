## 2026.07.29.1

**Added:** Incremental pull via sorted-set scores. Pull now fetches only paths
changed since `lastPulledSeq` using `ZRANGEBYSCORE`, converting pull from
O(total files) to O(changed files).

**Added:** Deleted paths are retained in the sorted set with `deleted: "true"`
metadata so incremental pulls receive tombstone signals. Previously, `ZREM` on
delete made deletions invisible to score-range queries.

**Changed:** Dirty-path diffs are collected in parallel and applied in a single
`applyChanges` call (1-3 pipeline flushes instead of N separate cycles).

**Changed:** `INCR` for the commit sequence now runs before pipeline writes,
not after. Each concurrent writer atomically reserves a unique seq. A wasted seq
on crash is acceptable — seq gaps do not affect correctness.

**Changed:** Pull throws on PATH_LIMIT truncation instead of silently dropping
paths beyond 50,000.

**Fixed:** ZSCAN MATCH patterns now escape glob metacharacters (`*`, `?`, `[`,
`]`, `\`) preventing mismatches on paths containing those characters.

**Fixed:** `pathsForPrefixes` deduplicates results when scope prefixes overlap.

## 2026.07.27.1

**Changed:** Bump @opentelemetry/api 1.9.0 → 1.9.1

## 2026.07.25.1

**Added:** OpenTelemetry spans for every layer of the datastore. Valkey round
trips emit one span each (`Valkey SET`, `Valkey ZRANGEBYLEX`,
`Valkey GETBUFFER`, `Valkey EVAL`, …) carrying `db.system.name`,
`db.operation.name`, and the key. Pipeline flushes emit
`Valkey pipeline writeFiles` / `deleteFiles` / `fetchMetadata` / `fetchHashes`
with the batched command count. The lock emits
`valkey-datastore lock acquire` / `release` / `withLock` / `inspect` /
`forceRelease`, with acquire recording wait duration and whether it contended.
The sync service emits `valkey-datastore pullChanged` / `pushChanged` /
`hydrateFile` / `preparePush` / `commitPush` with file counts, path counts, the
remote sequence number, and fast-path indicators.

**Added:** Lock contention retries are recorded as `retry` span events on the
acquire span.

**Added:** Pipeline spans report `valkey.pipeline.failed_commands` and are
marked as errors when any command in the batch failed. `pipeline.exec()`
resolves with per-command errors rather than rejecting, so a partially failed
batch would otherwise have left a span reporting success. `pullChanged` also
reports `datastore.files_skipped` for paths whose metadata read failed, which
were previously dropped silently.

**Changed:** `pushChanged` and `commitPush` now report
`datastore.files_pushed` and `datastore.files_deleted` separately. `applyChanges`
returns a single count covering writes and deletes together, and reporting that
as a file count would have overstated pushes whenever tombstones were involved.
The value returned to callers is unchanged.

**Changed:** Nothing else observable without tracing configured. The extension
depends on `@opentelemetry/api` only; the host process owns the
TracerProvider, and every span is a no-op when none is registered.

**Note:** Spans are placed on the round trips that carry latency — index range
scans, blob reads, and pipeline flushes — rather than on every one of the
seventeen command call sites. Heartbeat renewals are deliberately uninstrumented
so a long-held lock does not bury the trace in periodic `PEXPIRE` spans.

**Note on secrets:** Blob values are file content and the connection URL embeds
a password. Neither is ever recorded; span attributes carry only command names,
key names, and counts.
