# @webframp/cloudflare

Cloudflare management extension for
[swamp](https://github.com/systeminit/swamp). This extension provides five
models that cover the core Cloudflare surface area: zone management, DNS
records, WAF and firewall rules, Workers scripts and routes, and cache/CDN
operations. Each model communicates directly with the Cloudflare REST and
GraphQL APIs, so you can list, inspect, create, update, and delete resources
without leaving your swamp workspace.

## Prerequisites

- A **Cloudflare API token** with the permissions required by the models you
  plan to use:
  - Zone: `Zone:Read`, `Zone:Edit`
  - DNS: `DNS:Read`, `DNS:Edit`
  - WAF: `Firewall Services:Read`, `Firewall Services:Edit`
  - Workers: `Worker Scripts:Read`, `Worker Scripts:Edit`
  - Cache: `Cache Purge`
- Your **Cloudflare Zone ID** (visible on the zone overview page in the
  Cloudflare dashboard).
- For Workers operations, your **Cloudflare Account ID**.

## Installation

```bash
swamp extension pull @webframp/cloudflare
```

## Configuration

Create a model instance that references your Cloudflare credentials. The API
token is marked as sensitive and stored through your configured vault provider.

```yaml
# swamp model instance for DNS management
model: "@webframp/cloudflare/dns"
name: "production-dns"
globalArgs:
  apiToken: "vault://cloudflare/api-token"
  zoneId: "abc123def456"
```

## Usage

After creating a model instance, run methods against it from the CLI.

List all DNS records in a zone:

```bash
swamp model method run production-dns list
```

Create a new A record:

```bash
swamp model method run production-dns create \
  --type A \
  --name www \
  --content 203.0.113.50 \
  --proxied true \
  --comment "Primary web server"
```

## Models

| Model                         | Description                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `@webframp/cloudflare/zone`   | List, inspect, pause, unpause zones and manage zone-level settings.                 |
| `@webframp/cloudflare/dns`    | Full CRUD for DNS records plus BIND-format export.                                  |
| `@webframp/cloudflare/waf`    | Firewall rules, WAF packages, and security-event retrieval via GraphQL.             |
| `@webframp/cloudflare/worker` | Worker script lifecycle, route management, and workers.dev subdomain toggling.      |
| `@webframp/cloudflare/cache`  | Cache purge (all, URLs, tags, prefixes), cache settings, and analytics via GraphQL. |

## Troubleshooting

### Paginated results capped at 1,000 records

All list methods (zones, DNS records, WAF rules, worker scripts, routes) use a
shared paginated helper capped at `MAX_PAGES = 20` with 50 records per page.
Enterprise accounts with more than 1,000 DNS records, firewall rules, or worker
scripts per zone/account will get truncated results. The `truncated` field in
the output indicates when this cap was reached.

### No rate-limit retry

The extension has no 429 detection or retry logic. A Cloudflare rate-limit
response is treated as a generic API error and throws immediately. If you hit
rate limits on large zones, add delays between method invocations or reduce the
scope of queries.

### `get_security_events` returns empty events for nonexistent zones

The WAF model's GraphQL query returns an empty events array (not an error) when
the zone ID is not found in the GraphQL dataset. Zero events is
indistinguishable from "zone not found." Verify your zone ID with
`swamp model method run <zone-instance> list` first.

### `get_script` silently skips source code on non-2xx

The worker model's `get_script` method fetches metadata and source code in two
separate requests. If the source-code endpoint returns a non-2xx status
(permissions, script too large, edge timeout), metadata is returned successfully
but no source file is written. There is no error or warning for this case.

### `get_analytics` returns all-zero metrics for empty time ranges

The cache model's GraphQL analytics query returns zeroed metrics when no data
exists for the requested date range or when the zone ID does not match. Zero
cache-hit-rate is indistinguishable from "no traffic" or "wrong zone."

### API token must have correct permissions per model

Each model requires different Cloudflare API token permissions:

- Zone: `Zone:Read`, `Zone:Edit`
- DNS: `DNS:Read`, `DNS:Edit`
- WAF: `Firewall Services:Read`, `Firewall Services:Edit`
- Workers: `Worker Scripts:Read`, `Worker Scripts:Edit`
- Cache: `Cache Purge`

A token missing the required permission produces a generic "Cloudflare API
error" with the error code from the response. The error message does not
identify which permission is missing.

### Worker model uses `accountId`, not `zoneId`

Workers are account-scoped. The worker model's global arg is `accountId` (not
`zoneId`). Route methods accept `zoneId` as a per-method argument. Using
`zoneId` as the global arg will fail at the API level, not at validation.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
