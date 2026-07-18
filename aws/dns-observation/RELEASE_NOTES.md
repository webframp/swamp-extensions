## 2026.07.18.2

**Added:** An `upgrades` array entry (no-op) to `dns_observation.ts` for proper
`typeVersion` tracking on existing instances. No schema or behavior changes.

## 2026.07.18.1

**Changed:** Bumped `@aws-sdk/client-route-53` and `@aws-sdk/client-sts` from
`3.1069.0` to `3.1090.0` for dependency freshness. No behavior change.

# @webframp/aws/dns-observation v2026.07.03.1

**Changed:** Added JSDoc documentation to the model export for improved
`deno doc` and quality rubric compliance.

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
