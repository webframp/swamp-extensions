# @webframp/azure-blob-datastore

Stores swamp runtime data in Azure Blob Storage using native blob-lease
distributed locking and ETag-conditional writes on a shard-first path index.
No Azure SDK dependency — talks to the Blob REST API directly via `fetch`.

## Features

- **Native blob-lease locking** — the Azure lease ID doubles as the
  fencing-token nonce; Azure enforces the compare-and-swap server-side, so
  there's no hand-rolled CAS logic to get wrong
- **No SDK dependency** — Shared Key request signing (HMAC-SHA256 via
  `crypto.subtle`) and Azure AD OAuth are both implemented directly over
  `fetch`, matching `@webframp/gitlab-datastore`'s zero-dependency approach
- **Three explicit auth modes** — connection string, account key, or Azure AD
  service principal. No `DefaultAzureCredential`/managed-identity ambient
  discovery, by design
- **ETag-conditional shard index** — a `_index/` path index sharded by the
  first byte of `sha256(relPath)`, updated via optimistic-concurrency
  read-modify-write, mirroring the official S3/GCS datastores' `_index/`
  partition-shard pattern

## Configuration

```yaml
# .swamp.yaml
datastore:
  type: "@webframp/azure-blob-datastore"
  config:
    auth:
      mode: "connectionString"
      connectionString: "AccountName=myaccount;AccountKey=...;EndpointSuffix=core.windows.net"
    container: "swamp-datastore"
    # prefix: "swamp"  # default — namespaces multiple datastores in one container
```

Or with an account key directly:

```yaml
datastore:
  type: "@webframp/azure-blob-datastore"
  config:
    auth:
      mode: "sharedKey"
      accountName: "myaccount"
      accountKey: "..."
    container: "swamp-datastore"
```

Or via Azure AD service principal (client-credentials):

```yaml
datastore:
  type: "@webframp/azure-blob-datastore"
  config:
    auth:
      mode: "servicePrincipal"
      accountName: "myaccount"
      tenantId: "..."
      clientId: "..."
      clientSecret: "..."
    container: "swamp-datastore"
```

Or via environment variable:

```bash
export SWAMP_DATASTORE='@webframp/azure-blob-datastore:{"auth":{"mode":"connectionString","connectionString":"AccountName=...;AccountKey=..."},"container":"swamp-datastore"}'
```

## Required Setup

The container must already exist — this extension does **not** auto-create
it. Least-privilege Azure RBAC (`Storage Blob Data Contributor` scoped to one
container) commonly excludes container-create rights, so provision the
container via IaC or the Azure Portal/CLI before first use:

```bash
az storage container create --name swamp-datastore --account-name myaccount
```

## Required Permissions

- `Storage Blob Data Contributor` (or equivalent read/write/lease/list
  permissions) scoped to the target container

## Locking Details

Azure lease durations are fixed at 15-60 seconds (or infinite, which this
extension never uses — an infinite lease would strand the lock forever if the
holder crashes). A caller's requested `ttlMs` is clamped into that range, and
the lock is kept alive via heartbeat renewal at roughly a third of the actual
lease duration — the same renewal cadence convention as the postgres/valkey
datastores, just keyed to Azure's real lease length instead of the raw
`ttlMs`.

## Observability

The extension emits [OpenTelemetry](https://opentelemetry.io/) spans for blob
operations, lock acquisition/release, and push/pull sync. It depends on
`@opentelemetry/api` only — the host process owns the `TracerProvider`, so
every span is a no-op when none is registered. When swamp runs with OTel
enabled, datastore activity appears in traces nested under swamp's own
`swamp.datastore.*` spans.

Three layers are instrumented:

- **Blob REST calls** — one span per request (`Azure Blob putBlob`,
  `Azure Blob lease.acquire`, `Azure Blob listBlobs`, …) with
  `azure.blob.container`, `azure.blob.key`, `http.request.method`,
  `http.response.status_code`, `http.response.body.size`, and
  `azure.request_id`.
- **Lock** — `azure-blob-datastore lock acquire` / `release` / `withLock` /
  `inspect` / `forceRelease`. Acquire records `lock.wait_duration_ms` and
  `lock.contended`; inspect records `lock.holder`. Heartbeat renewals are
  deliberately not given their own span — a lock held for minutes would
  otherwise bury the trace in periodic noise.
- **Sync** — `azure-blob-datastore pullChanged` / `pushChanged` /
  `hydrateFile` / `preparePush` / `commitPush`, with `datastore.files_pulled`,
  `datastore.files_pushed`, `datastore.files_deleted`, and
  `datastore.fast_path_hit`. The multi-round-trip internals
  (`listIndexShards`, `queryAllFileMeta`, `updateShard`) get their own spans so
  a slow index scan is distinguishable from slow content transfer.

Retries appear as `retry` events on the enclosing span, with
`retry.attempt`, `retry.delay_ms`, and `retry.reason` — either
`retryable_status` for 429/5xx backoff or `etag_conflict` for the shard index
CAS loop.

Credential material is never recorded. Shared Key signatures, AAD client
secrets, and bearer tokens do not appear in any attribute; the AAD token
exchange span carries only its response status.

## Development

```bash
cd datastore/azure-blob
deno task check
deno task lint
deno task fmt
deno task test
```

All tests run against a hand-rolled in-process mock Blob Storage server — no
live Azure calls, no Azurite dependency.
