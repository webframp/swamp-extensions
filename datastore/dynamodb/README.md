# @webframp/dynamodb-datastore

Stores swamp runtime data in AWS DynamoDB using a single-table design, with
conditional-write distributed locking and chunked blob storage for items over
DynamoDB's 400KB size limit.

## Features

- **Conditional-write distributed locking** with fencing-token nonces —
  `PutItem`/`UpdateItem`/`DeleteItem` conditional expressions provide the same
  compare-and-swap safety as the postgres/valkey datastores
- **TTL as defense-in-depth, not correctness** — the native DynamoDB `ttl`
  attribute exists only to eventually garbage-collect abandoned lock items;
  `acquire()` always does an explicit client-computed staleness check, since
  DynamoDB's TTL sweep can lag up to 48h
- **Serverless, zero-ops** — no server to provision or patch; pay-per-request
  billing scales to zero
- **Chunked blob storage** — files over `maxChunkBytes` are split across
  multiple items and reassembled on read, working around DynamoDB's per-item
  size ceiling
- **DynamoDB Local support** — `endpoint` config field for local development
  and CI without touching live AWS

## Configuration

```yaml
# .swamp.yaml
datastore:
  type: "@webframp/dynamodb-datastore"
  config:
    region: "us-east-1" # default: "us-east-1"
    tableName: "swamp-datastore" # default: "swamp-datastore"
    # endpoint: "http://localhost:8000"  # DynamoDB Local only — leave unset for production
    # autoCreateTable: false             # default: false — see "Required Schema" below
    # maxChunkBytes: 262144              # default: 256KB
```

Or via environment variable:

```bash
export SWAMP_DATASTORE='@webframp/dynamodb-datastore:{"tableName":"swamp-datastore","region":"us-east-1"}'
```

No credentials are accepted in config. This extension uses the AWS SDK's
default credential provider chain (environment variables, shared config/
profile, or an attached IAM role) — the same convention as every other
`@webframp/aws/*` extension in this repo.

## Required Schema

DynamoDB tables are not auto-created by default (`autoCreateTable: false`) —
provision the table via IaC before first use:

- **Partition key:** `pk` (String)
- **Sort key:** `sk` (String)
- **TTL attribute:** `ttl` (Number, epoch seconds) — enable DynamoDB's native
  TTL on this attribute; it is defense-in-depth cleanup only, never relied on
  for lock correctness
- **Billing mode:** `PAY_PER_REQUEST` recommended
- **Global secondary index** `gsi1` — partition key `gsi1pk` (String), sort
  key `gsi1sk` (String), projection `ALL` — used for cheap `Query`-based
  full-walk diffs and prefix-scoped sync during sync instead of a table
  `Scan`. Only file-metadata items carry `gsi1pk`/`gsi1sk` attributes; lock
  items and file chunks are excluded from the index automatically, so `ALL`
  projection never leaks chunk content into the index.

Set `autoCreateTable: true` to have the extension create the table (with the
above schema, TTL, and GSI) on first use — convenient for local development,
but production tables should be provisioned via IaC so table creation isn't
gated on IAM permissions the runtime credential may not have.

### Item layout (single table)

| Item | `pk` | `sk` | Notes |
|---|---|---|---|
| Lock | `LOCK#<key>` | `LOCK` | `nonce`, `acquiredAtMs`, `expiresAtMs`, `ttl` |
| File metadata | `FILE#<relPath>` | `META` | `hash`, `size`, `chunkCount`, `updatedAt`, `gsi1pk`, `gsi1sk` |
| File chunk | `FILE#<relPath>` | `CHUNK#0000`... | `content` (Binary) |
| Sync watermark | `SYNCSTATE#global` | `STATE` | `lastPushedAt` |

## Required IAM Permissions

- `dynamodb:GetItem`
- `dynamodb:PutItem`
- `dynamodb:UpdateItem`
- `dynamodb:DeleteItem`
- `dynamodb:Query`
- `dynamodb:BatchWriteItem`
- `dynamodb:DescribeTable`
- `dynamodb:CreateTable` (only if `autoCreateTable: true`)

## DynamoDB Local (development)

```bash
docker run -p 8000:8000 amazon/dynamodb-local
```

```yaml
datastore:
  type: "@webframp/dynamodb-datastore"
  config:
    tableName: "swamp-datastore"
    endpoint: "http://localhost:8000"
    autoCreateTable: true
```

## Development

```bash
cd datastore/dynamodb
deno task check
deno task lint
deno task fmt
deno task test

# Integration tests (requires DynamoDB Local)
docker run -p 8000:8000 amazon/dynamodb-local
DYNAMODB_TEST_ENDPOINT="http://localhost:8000" deno task test
```
