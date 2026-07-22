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
