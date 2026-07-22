## 2026.07.22.1

**Added:** Initial release of `@webframp/azure-blob-datastore`. Stores swamp
runtime data in Azure Blob Storage with native blob-lease distributed locking
(the Azure lease ID doubles as the fencing-token nonce — Azure enforces the
compare-and-swap server-side, no custom CAS logic needed), ETag-conditional
writes on a shard-first path index for optimistic concurrency, and two-phase
sync (`preparePush`/`commitPush`).

**Added:** Three explicit authentication modes — `connectionString`,
`sharedKey` (account name/key), and `servicePrincipal` (Azure AD
client-credentials). `DefaultAzureCredential`/managed-identity chains are
intentionally not supported, matching this repo's preference for explicit
config over ambient credential discovery.

**Upgrade note:** No `@azure/*` SDK dependency — this extension talks to the
Blob REST API directly via `fetch`, the same zero-dependency approach already
used by `@webframp/gitlab-datastore` and `@webframp/azure/openai-usage`.
Fixed-duration leases (15-60s, clamped from the caller's `ttlMs`) with
heartbeat renewal are used instead of Azure's infinite-lease option, so a
crashed holder's lock still self-expires — matching the failure-mode parity
of the postgres/valkey datastores.
