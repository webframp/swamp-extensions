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

- **list_zones** — All hosted zones with record counts, public/private status, VPC associations
- **list_records** — All record sets across zones (A, AAAA, CNAME, ALIAS, etc.)
- **detect_orphans** — Cross-reference record targets against inventory/adopt data

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

| Record Type | Target | Checked Against |
|-------------|--------|-----------------|
| A (alias) | ELB DNS name | inventory elbv2/elb |
| A (alias) | CloudFront domain | inventory cloudfront |
| A (alias) | S3 website endpoint | inventory s3 |
| A (value) | IP address | inventory ec2 + adopt elasticIps |
| CNAME | ELB DNS name | inventory elbv2/elb |
| CNAME | S3 website endpoint | inventory s3 |

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

## Integration with drift-state

This model's `orphans` spec is consumed by `@webframp/aws/drift-state` as an
upstream source. Orphaned records appear as drifted resources with
`detectionSource: "dns"`.
