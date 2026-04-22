# @webframp/cloudflare-audit

Cloudflare security and configuration audit workflow. This extension inspects
zone settings, DNS records, WAF rules, Workers, and cache configuration for a
Cloudflare zone, then generates a severity-rated report with findings and
actionable recommendations.

## Checks Performed

- **Zone** -- SSL mode (off/flexible/full/strict), Always Use HTTPS, development mode, zone paused/active status
- **WAF** -- Firewall rules present and active, WAF managed rulesets enabled, paused rule detection
- **DNS** -- Unproxied records exposing origin IPs, dangling CNAMEs (subdomain takeover risk), CAA record presence
- **Workers** -- Orphaned worker scripts with no routes
- **Cache** -- Cache level configuration, cache hit rate against a configurable threshold

## Prerequisites

- [swamp](https://github.com/systeminit/swamp) CLI installed
- The `@webframp/cloudflare` extension (installed automatically as a dependency)
- A Cloudflare API token with read access to zones, DNS, WAF, Workers, and cache settings
- Your Cloudflare Zone ID and Account ID

## Installation

```bash
swamp extension pull @webframp/cloudflare-audit
```

## Configuration

Create the required model instances that the audit workflow references:

```bash
swamp model create @webframp/cloudflare/zone cf-zone \
  --global-arg apiToken=CLOUDFLARE_API_TOKEN

swamp model create @webframp/cloudflare/dns cf-dns \
  --global-arg apiToken=CLOUDFLARE_API_TOKEN \
  --global-arg zoneId=YOUR_ZONE_ID

swamp model create @webframp/cloudflare/waf cf-waf \
  --global-arg apiToken=CLOUDFLARE_API_TOKEN \
  --global-arg zoneId=YOUR_ZONE_ID

swamp model create @webframp/cloudflare/worker cf-worker \
  --global-arg apiToken=CLOUDFLARE_API_TOKEN \
  --global-arg accountId=YOUR_ACCOUNT_ID

swamp model create @webframp/cloudflare/cache cf-cache \
  --global-arg apiToken=CLOUDFLARE_API_TOKEN \
  --global-arg zoneId=YOUR_ZONE_ID
```

## Usage

Run the audit workflow:

```bash
swamp workflow run @webframp/cloudflare-audit --input zoneId=YOUR_ZONE_ID
```

The workflow collects data from all five Cloudflare model types, then the report
analyzes the results and produces a Markdown summary with an overall status
(HEALTHY, WARNING, CRITICAL, or DEGRADED), a findings table, and numbered
recommendations.

## Report Output

The report returns both Markdown (for human review) and structured JSON (for
programmatic consumption). Each finding includes a check category, severity
level (`ok`, `warn`, `critical`, or `error`), and a descriptive message.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
