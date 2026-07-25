## 2026.07.25.1

**Added:** OpenTelemetry spans for every layer of the datastore. Blob REST
calls emit one span each (`Azure Blob putBlob`, `Azure Blob lease.acquire`, …)
carrying container, blob key, HTTP method, response status, body size, and the
`x-ms-request-id`. The lock emits `azure-blob-datastore lock acquire` /
`release` / `withLock` / `inspect` / `forceRelease`, with acquire recording
wait duration and whether it contended. The sync service emits
`azure-blob-datastore pullChanged` / `pushChanged` / `hydrateFile` /
`preparePush` / `commitPush` with file counts and fast-path indicators, plus
spans on the multi-round-trip internals (`listIndexShards`,
`queryAllFileMeta`, `updateShard`).

**Added:** Retries are recorded as `retry` span events on the enclosing
operation — both the 429/5xx backoff in `retryableRequest` and the ETag
conflict loop in `updateShard`, which retries independently of it.

**Changed:** Nothing observable without tracing configured. The extension
depends on `@opentelemetry/api` only; the host process owns the
TracerProvider, and every span is a no-op when none is registered. Existing
behaviour, return values, and log output are unchanged.

**Note on secrets:** Shared Key signatures, AAD client secrets, and bearer
tokens are never recorded as span attributes. The AAD token exchange emits a
span carrying only the response status.
