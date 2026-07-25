## 2026.07.25.1

**Added:** OpenTelemetry spans for every layer of the datastore. Each SQL round
trip emits a span named for the operation it performs
(`PostgreSQL acquireLock`, `PostgreSQL scanFileMetadata`,
`PostgreSQL commitPushTransaction`, …) carrying `db.system.name`,
`db.operation.name`, `db.collection.name`, and returned row counts. The lock
emits `postgres-datastore lock acquire` / `release` / `withLock` / `inspect` /
`forceRelease`, with acquire recording wait duration and whether it contended.
The sync service emits `postgres-datastore pullChanged` / `pushChanged` /
`hydrateFile` / `preparePush` / `commitPush` with file counts and fast-path
indicators.

**Added:** Retries are recorded as `retry` span events on the enclosing
operation — both the transient-error backoff in `retryable` and the lock
contention loop.

**Changed:** `pushChanged` now reports `datastore.files_pushed` and
`datastore.files_deleted` separately. The internal push helpers previously
returned a single count covering writes and tombstones together; reporting that
as a file count would have overstated pushes whenever tombstones were involved.
The value returned to callers is unchanged.

**Changed:** Nothing else observable without tracing configured. The extension
depends on `@opentelemetry/api` only; the host process owns the
TracerProvider, and every span is a no-op when none is registered.

**Note:** The existing `SWAMP_PG_SYNC_TRACE=1` phase tracer is untouched and
still writes its own timing lines to stderr. The two are independent — enable
either, both, or neither.

**Note on secrets:** Statement text and bound parameters are never recorded.
Query parameters carry file content and the connection string carries a
password, so span attributes hold only hand-written operation labels, table
names, and counts.
