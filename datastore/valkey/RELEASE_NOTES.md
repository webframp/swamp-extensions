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
