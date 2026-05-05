# @webframp/postgres-datastore

Stores swamp runtime data in PostgreSQL with row-based distributed locking.
Compatible with AWS RDS, Aurora, and Aurora Serverless v2.

## Features

- **Row-based distributed locking** with fencing tokens — survives Aurora
  failover (unlike advisory locks which are lost on promotion)
- **Heartbeat-based TTL** — stale locks from crashed processes are automatically
  reclaimed
- **RDS/Aurora compatible** — tested with standard RDS PostgreSQL, Aurora
  provisioned, and Aurora Serverless v2
- **SSL/TLS support** — configurable modes including CA verification for RDS
  certificate bundles

## Configuration

```yaml
# .swamp.yaml
datastore:
  type: "@webframp/postgres-datastore"
  config:
    connectionString: "postgres://user:pass@your-host:5432/swamp"
    schema: "swamp"        # default: "swamp"
    ssl: "verify-ca"       # default: "require"
    sslCaPath: "/path/to/rds-global-bundle.pem"  # required when ssl=verify-ca
```

Or via environment variable:

```bash
export SWAMP_DATASTORE='@webframp/postgres-datastore:{"connectionString":"postgres://user:pass@host:5432/db"}'
```

## Required Schema

Run this SQL against your PostgreSQL database before first use:

```sql
CREATE SCHEMA IF NOT EXISTS swamp;

CREATE TABLE swamp.locks (
  key         TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  hostname    TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ttl_ms      INTEGER NOT NULL DEFAULT 30000,
  nonce       TEXT NOT NULL
);
```

## SSL Modes

| Mode        | Behavior                                            |
|-------------|-----------------------------------------------------|
| `disable`   | No TLS (local development only)                     |
| `require`   | TLS without CA verification (default)               |
| `verify-ca` | TLS with CA certificate verification (recommended)  |

For AWS RDS/Aurora, download the CA bundle:

```bash
curl -o /etc/ssl/certs/rds-global-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

## Aurora Compatibility Notes

- Use the **cluster writer endpoint** (not reader endpoint)
- Set Aurora Serverless v2 minimum ACU >= 0.5 to prevent scale-to-zero
- Lock state survives failover (stored in WAL-replicated table)
- Fencing tokens prevent split-brain during promotion events

## Development

```bash
cd datastore/postgres
deno task check
deno task lint
deno task fmt
deno task test

# Integration tests (requires a real PostgreSQL instance)
POSTGRES_TEST_URL="postgres://user:pass@localhost:5432/test" deno task test
```
