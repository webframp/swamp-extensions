## 2026.07.22.1

**Added:** Initial release of `@webframp/dynamodb-datastore`. Stores swamp
runtime data in AWS DynamoDB using a single-table design (locks, chunked file
blobs, and sync watermark share one table, keyed by `pk`/`sk`). Distributed
locking uses conditional writes with fencing-token nonces; native DynamoDB TTL
is used only as defense-in-depth cleanup of abandoned lock items — acquire-side
staleness checks never depend on TTL sweep timing (which AWS documents as
taking up to 48h).

**Added:** Two-phase sync (`preparePush`/`commitPush`) with per-file chunking
for blobs exceeding DynamoDB's 400KB item limit (default 256KB raw chunk size,
tunable via `maxChunkBytes`).

**Added:** `endpoint` config field for pointing at DynamoDB Local during
development; `autoCreateTable` opt-in for provisioning the table on first use
(default off — production tables should be provisioned via IaC; see the
README's "Required Schema" section).

Credentials are never accepted in datastore config — this extension uses the
AWS SDK's default credential provider chain (environment, shared config, IAM
role), matching every other `@webframp/aws/*` extension in this repo.
