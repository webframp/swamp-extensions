# @webframp/aws/dns-observation v2026.06.27.2

Initial release.

## Methods

- **list_zones** — List all Route53 hosted zones with record counts,
  public/private status, and VPC associations
- **list_records** — List all record sets across zones with pagination support
- **detect_orphans** — Cross-reference DNS record targets against
  inventory/adopt data to find orphaned entries pointing at decommissioned
  infrastructure

## Orphan Detection

Identifies DNS records pointing at resources no longer present in inventory:

- ELB aliases not found in inventory
- CloudFront aliases not found in inventory
- S3 website endpoints not found in inventory
- A record IPs not found in EC2 public IPs or Elastic IPs
- CNAME targets pointing at missing ELBs or S3 buckets

Excludes RFC 1918, loopback, and link-local addresses from IP checks. Reports
`truncated: true` when pagination limits are reached.
