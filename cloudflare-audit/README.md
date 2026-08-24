# @webframp/cloudflare-audit

Cloudflare security and configuration audit workflow. This extension inspects
zone settings, DNS records, WAF rules, Workers, and cache configuration for a
Cloudflare zone, then generates a severity-rated report with findings and
actionable recommendations.

## Checks Performed

- **Zone** -- SSL mode (off/flexible/full/strict), Always Use HTTPS, development
  mode, zone paused/active status
- **WAF** -- Firewall rules present and active, WAF managed rulesets enabled,
  paused rule detection
- **DNS** -- Unproxied records exposing origin IPs, dangling CNAMEs (subdomain
  takeover risk), CAA record presence
- **Workers** -- Orphaned worker scripts with no routes
- **Cache** -- Cache level configuration, cache hit rate against a configurable
  threshold

## Prerequisites

- [swamp](https://github.com/systeminit/swamp) CLI installed
- The `@webframp/cloudflare` extension (installed automatically as a dependency)
- A Cloudflare API token with read access to zones, DNS, WAF, Workers, and cache
  settings
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

## Troubleshooting

### Report shows "HEALTHY" despite misconfigured model instances

The workflow marks all data-collection steps as `allowFailure: true`. If a model
instance has wrong credentials or missing permissions, the step fails silently,
and the report omits findings for that domain. Worker and cache check functions
return empty findings (not errors) when their data is null, so a fully failed
worker or cache model produces a "HEALTHY" report rather than flagging the data
gap.

### Hardcoded model instance names

The workflow references `cf-zone`, `cf-dns`, `cf-waf`, `cf-worker`, and
`cf-cache` by exact name. Model instances must be created with these names.
Using different names causes step failures that are silently absorbed by
`allowFailure: true`, producing a degraded report with no explanation.

### "No zone data available" or "No WAF data available" findings

These `severity: "error"` findings mean the corresponding model instance failed
during data collection. Common causes: expired API token, token missing required
permissions, wrong `zoneId` or `accountId` global arg, or network issues. Check
`swamp run history` to see which workflow steps failed.

### Security events limited to 100 per run

The workflow passes `limit: 100` to `get_security_events`. High-traffic zones
may have more events in the analysis window. This is a workflow-level cap, not a
pagination limit in the report itself.

### Report output location

Use `swamp report get <report-name> --model <model>` to retrieve the latest
report output. The report produces both Markdown (for human review) and
structured JSON (for programmatic consumption).

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
