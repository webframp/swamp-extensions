# @webframp/aws/dns-observation

Observe Route53 hosted zones, record sets, and detect orphaned DNS records
pointing at decommissioned infrastructure.

This model reads Route53 data — it does not manage zones or records. Use
`@swamp/aws/route53` for infrastructure management.

## Prerequisites

Route53 read access:

- `route53:ListHostedZones`
- `route53:GetHostedZone`
- `route53:ListResourceRecordSets`
- `sts:GetCallerIdentity`

For orphan detection, upstream models must have fresh data:

- `@webframp/aws/inventory` (scan spec) — EC2 IPs, ELBs, S3, CloudFront
- `@webframp/aws/adopt` (discovery spec) — Elastic IPs

## Methods

- **list_zones** — All hosted zones with record counts, public/private status,
  VPC associations
- **list_records** — All record sets across zones (A, AAAA, CNAME, ALIAS, etc.)
- **detect_orphans** — Cross-reference record targets against inventory/adopt
  data

## Usage

```bash
swamp extension pull @webframp/aws/dns-observation
swamp model create @webframp/aws/dns-observation aws-dns-observation
swamp model method run aws-dns-observation list_zones
swamp model method run aws-dns-observation list_records
swamp model method run aws-dns-observation detect_orphans
```

## Orphan Detection

The `detect_orphans` method reads stored record data and cross-references
targets against upstream model data:

| Record Type | Target              | Checked Against                  |
| ----------- | ------------------- | -------------------------------- |
| A (alias)   | ELB DNS name        | inventory elbv2/elb              |
| A (alias)   | CloudFront domain   | inventory cloudfront             |
| A (alias)   | S3 website endpoint | inventory s3                     |
| A (value)   | IP address          | inventory ec2 + adopt elasticIps |
| CNAME       | ELB DNS name        | inventory elbv2/elb              |
| CNAME       | S3 website endpoint | inventory s3                     |

Records of type NS, SOA, TXT, MX, SRV are skipped by default.

## Query Examples

```bash
# Find all orphaned records
swamp data query aws-dns-observation \
  'data.latest("aws-dns-observation", "orphans").attributes.orphans'

# Count orphans by reason
swamp data query aws-dns-observation \
  'data.latest("aws-dns-observation", "orphans").attributes.summary.byReason'

# List all public zones
swamp data query aws-dns-observation \
  'data.latest("aws-dns-observation", "zones").attributes.zones.filter(z, !z.isPrivate)'
```

## Troubleshooting

### `list_records` silently skips zones that fail

When `ListResourceRecordSets` throws for a specific zone, the method logs a
warning and continues with remaining zones. The final result omits records from
the failed zone, but `truncated` does not reflect this. If your record count
seems low, check the method logs for per-zone warnings (visible via
`swamp run history`).

### `detect_orphans` returns zero orphans with no error

The orphan detection method reads previously collected data from `list_records`,
`@webframp/aws/inventory`, and `@webframp/aws/adopt`. If any of those data
sources are missing (methods not run yet), the detection proceeds with empty
reference sets rather than failing. When all reference data is absent, no
records can be matched as orphaned, so the result is `orphans: []` — run
`list_records` and the upstream inventory/adopt methods first.

### `MAX_PAGES = 50` truncation

Zone listing and per-zone record pagination are each capped at 50 pages. With
default AWS page sizes (~100 zones per page, ~300 records per page), this covers
up to 5,000 zones and 15,000 records per zone. The `truncated` field is set
honestly when zone-level caps are reached, but there is no indication of _which_
zone was truncated.

### Region default and Route 53

Route 53 is a global service; the region parameter (`us-east-1` by default) only
affects the API endpoint hostname and STS credential resolution. Changing the
region does not filter zones by geography. Pass `--global-arg profile=<name>`
for multi-account access.

### `detect_orphans` reports false "missing_in_aws" when upstream data is absent

When inventory or adopt data fails to load, the orphan detector has no reference
set for that resource type. CNAME targets pointing at ELBs or CloudFront
distributions will not be matched and may appear as orphans. The method uses a
conservative approach — it returns `null` (no opinion) rather than
false-positive orphans for types with empty reference sets.

## Integration with drift-state

This model's `orphans` spec is consumed by `@webframp/aws/drift-state` as an
upstream source. Orphaned records appear as drifted resources with
`detectionSource: "dns"`.
