# @webframp/cloudflare

Cloudflare management extension for [swamp](https://github.com/systeminit/swamp). This extension provides five models that cover the core Cloudflare surface area: zone management, DNS records, WAF and firewall rules, Workers scripts and routes, and cache/CDN operations. Each model communicates directly with the Cloudflare REST and GraphQL APIs, so you can list, inspect, create, update, and delete resources without leaving your swamp workspace.

## Prerequisites

- A **Cloudflare API token** with the permissions required by the models you plan to use:
  - Zone: `Zone:Read`, `Zone:Edit`
  - DNS: `DNS:Read`, `DNS:Edit`
  - WAF: `Firewall Services:Read`, `Firewall Services:Edit`
  - Workers: `Worker Scripts:Read`, `Worker Scripts:Edit`
  - Cache: `Cache Purge`
- Your **Cloudflare Zone ID** (visible on the zone overview page in the Cloudflare dashboard).
- For Workers operations, your **Cloudflare Account ID**.

## Installation

```bash
swamp extension pull @webframp/cloudflare
```

## Configuration

Create a model instance that references your Cloudflare credentials. The API token is marked as sensitive and stored through your configured vault provider.

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
swamp model run production-dns list
```

Create a new A record:

```bash
swamp model run production-dns create \
  --type A \
  --name www \
  --content 203.0.113.50 \
  --proxied true \
  --comment "Primary web server"
```

## Models

| Model | Description |
|-------|-------------|
| `@webframp/cloudflare/zone` | List, inspect, pause, unpause zones and manage zone-level settings. |
| `@webframp/cloudflare/dns` | Full CRUD for DNS records plus BIND-format export. |
| `@webframp/cloudflare/waf` | Firewall rules, WAF packages, and security-event retrieval via GraphQL. |
| `@webframp/cloudflare/worker` | Worker script lifecycle, route management, and workers.dev subdomain toggling. |
| `@webframp/cloudflare/cache` | Cache purge (all, URLs, tags, prefixes), cache settings, and analytics via GraphQL. |

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
