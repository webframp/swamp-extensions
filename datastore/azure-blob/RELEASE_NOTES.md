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

**Changed:** `pullChanged` reports `datastore.files_pulled` and
`datastore.files_deleted` separately. The internal pull counter increments for
both a downloaded file and a local file removed by a remote tombstone, so
reporting it as a pull count would have overstated downloads whenever
tombstones were applied.

**Changed:** Nothing observable without tracing configured. The extension
depends on `@opentelemetry/api` only; the host process owns the
TracerProvider, and every span is a no-op when none is registered. Existing
behaviour and return values are unchanged.

**Note on secrets:** Shared Key signatures, AAD client secrets, and bearer
tokens are never recorded as span attributes. The AAD token exchange emits a
span carrying only its response status — on failure the response body is
deliberately dropped from the error message, because `recordException` would
otherwise put the token endpoint's raw response into the trace.

**Note:** Lock heartbeat renewals run detached from the acquiring span. A span
created inside the renewal timer would otherwise be parented to an
already-ended `lock acquire` span, which trace backends render as a broken
trace.
