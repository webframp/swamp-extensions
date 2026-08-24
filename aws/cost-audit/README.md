# @webframp/aws-cost-audit

AWS cost audit extension for [swamp](https://github.com/systeminit/swamp). This
extension orchestrates a multi-stage workflow that gathers spend data from AWS
Cost Explorer, collects resource inventory, inspects networking infrastructure,
and produces a consolidated savings report with prioritized recommendations.

## Features

- Month-over-month cost comparison with automated anomaly detection (>25% spike
  flagging)
- Per-service deep dives for EC2, RDS, S3, and Lambda usage types
- Networking waste analysis covering NAT Gateways, Load Balancers, and
  unattached Elastic IPs
- Infrastructure inventory with stopped EC2 instances and orphaned EBS volumes
- Prioritized recommendations table with estimated monthly savings

## Prerequisites

The workflow depends on three model instances. Create them before running:

```bash
swamp extension pull @webframp/aws-cost-audit

swamp model create @webframp/aws/cost-explorer aws-costs \
  --global-arg region=us-east-1

swamp model create @webframp/aws/networking aws-networking \
  --global-arg region=us-east-1

swamp model create @webframp/aws/inventory aws-inventory \
  --global-arg region=us-east-1
```

## Usage

Run the workflow and view the generated report:

```bash
swamp workflow run @webframp/cost-audit
swamp report view @webframp/cost-audit-report --latest
```

Customize the lookback window with workflow inputs:

```bash
swamp workflow run @webframp/cost-audit \
  --input region=us-west-2 \
  --input costDays=90 \
  --input metricsDays=14
```

## Required IAM Permissions

- `ce:GetCostAndUsage`
- `ec2:DescribeInstances`, `ec2:DescribeNatGateways`, `ec2:DescribeAddresses`
- `rds:DescribeDBInstances`
- `dynamodb:ListTables`, `dynamodb:DescribeTable`
- `lambda:ListFunctions`
- `s3:ListBuckets`
- `elasticloadbalancing:DescribeLoadBalancers`,
  `elasticloadbalancing:DescribeTargetGroups`,
  `elasticloadbalancing:DescribeTargetHealth`
- `cloudwatch:GetMetricStatistics`

## Troubleshooting

### Report shows "No data available" for every section

The workflow marks all 13 gather steps as `allowFailure: true`. If every step
fails (credential issues, missing permissions, wrong region), the workflow still
"succeeds" and produces a report with placeholder text in every section. Check
`swamp workflow history search --json` or `swamp run history` to confirm which
steps actually completed.

### Workflow `--input region=...` has no effect

The workflow's `region` input exists in the schema but is never passed to any
step. The actual region comes from the `--global-arg region=...` set when
creating the dependent model instances (`aws-costs`, `aws-networking`,
`aws-inventory`). To target a different region, recreate those model instances.

### Partial results without indication

When a step fails, its corresponding report section falls through to a
placeholder message ("No cost-by-service data available," etc.). There is no
consolidated list of which sections were populated vs degraded. Compare the
report output against the 13 expected sections to identify gaps.

### `MAX_PAGES = 10` in networking and inventory

The dependent `aws/networking` and `aws/inventory` models each cap pagination at
10 pages. Large accounts with more than ~1,000 NAT gateways, load balancers, or
resources per type will have truncated data feeding into the audit. The report
does not surface the upstream `truncated` flags.

### Inventory model expects `regions` (array), not `region` (string)

The `@webframp/aws/inventory` model requires
`--global-arg regions='["us-east-1"]'` (an array). A bare
`--global-arg region=us-east-1` will fail Zod validation. The `cost-explorer`
and `networking` models use the singular `region` string.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md).
