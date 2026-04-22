# @webframp/aws-cost-audit

AWS cost audit extension for [swamp](https://github.com/systeminit/swamp). This
extension orchestrates a multi-stage workflow that gathers spend data from AWS
Cost Explorer, collects resource inventory, inspects networking infrastructure,
and produces a consolidated savings report with prioritized recommendations.

## Features

- Month-over-month cost comparison with automated anomaly detection (>25% spike flagging)
- Per-service deep dives for EC2, RDS, S3, and Lambda usage types
- Networking waste analysis covering NAT Gateways, Load Balancers, and unattached Elastic IPs
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
- `elasticloadbalancing:DescribeLoadBalancers`, `elasticloadbalancing:DescribeTargetGroups`, `elasticloadbalancing:DescribeTargetHealth`
- `cloudwatch:GetMetricStatistics`

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md).
