## 2026.07.29.1

**Added:** Monotonic `commitSeq` via PostgreSQL sequence. Pull fast-path now
compares a single integer instead of parsing timestamps, eliminating clock-skew
vulnerabilities across concurrent writers.

**Changed:** Dirty-path pushes are batched into a single transaction (was N
separate `BEGIN/COMMIT` pairs). One watermark write instead of N. Expected
10-50x latency improvement for incremental pushes.

**Changed:** Pull captures `commitSeq` before the metadata scan (not after) to
prevent TOCTOU races where concurrent pushes during the fetch window could be
silently missed.

**Changed:** Content-fetch batches during pull run up to 3 in parallel via
`Promise.all`.

**Changed:** Manifest query for push uses batch path lookups (IN clause) instead
of a full table scan when `lastPulledAt` provides a bound.

**Added:** Tombstone garbage collection — every push transaction deletes
tombstones older than 7 days, preventing unbounded table growth.

## 2026.07.27.1

**Changed:** Bump @opentelemetry/api 1.9.0 → 1.9.1

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
`datastore.files_deleted` separately, and `pullChanged` likewise separates
downloads from local deletions. The internal counters increment for both writes
and tombstones, so reporting either as a file count would have overstated it.
The values returned to callers are unchanged.

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
