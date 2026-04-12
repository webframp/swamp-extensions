# AWS Cost Audit Extension Design

## Overview

A workflow extension that audits AWS infrastructure costs by combining spend
data from Cost Explorer, resource inventory, and networking inspection to
identify waste and generate actionable savings recommendations.

Inspired by common patterns where "standard" architectures (ALB + NAT Gateway +
private subnets) create hidden baseline costs that dominate small/medium account
bills.

## Architecture

```
@webframp/aws-cost-audit (workflow + report)
├── @webframp/aws/cost-explorer (NEW — Cost Explorer API)
├── @webframp/aws/networking (NEW — EC2/ELBv2 APIs)
├── @webframp/aws/inventory (EXISTING — resource discovery)
└── @webframp/aws/cost-estimate (EXISTING — pricing lookups)
```

Each new model is a standalone extension in its own directory with its own
manifest, deno.json, and tests. The workflow extension lives in `aws/cost-audit/`.

```
aws/
├── cost-explorer/          # NEW model
├── networking/             # NEW model
├── cost-audit/             # NEW workflow + report
├── inventory/              # existing
├── cost-estimate/          # existing
└── ...
```

## New Model: `@webframp/aws/cost-explorer`

Wraps the AWS Cost Explorer API for actual spend analysis.

**Dependencies:** `@aws-sdk/client-cost-explorer`

**Required IAM Permissions:**
- `ce:GetCostAndUsage`
- `ce:GetCostForecast`

**Methods:**

| Method | Description |
|--------|-------------|
| `get_cost_by_service` | Spend breakdown by AWS service for a time period (e.g., last 30 days) |
| `get_cost_by_usage_type` | Drill into a specific service's usage types (e.g., NatGateway-Bytes, DataTransfer-Out) |
| `get_cost_trend` | Daily/monthly cost time series for trend detection |
| `get_top_cost_drivers` | Top N most expensive line items, sorted by spend |

## New Model: `@webframp/aws/networking`

Inspects VPC networking resources that commonly generate hidden costs.

**Dependencies:** `@aws-sdk/client-ec2`, `@aws-sdk/client-elastic-load-balancing-v2`

**Required IAM Permissions:**
- `ec2:DescribeNatGateways`
- `ec2:DescribeAddresses`
- `ec2:DescribeVpcs`
- `ec2:DescribeSubnets`
- `elasticloadbalancing:DescribeLoadBalancers`
- `elasticloadbalancing:DescribeTargetGroups`
- `elasticloadbalancing:DescribeTargetHealth`
- `cloudwatch:GetMetricStatistics`

**Methods:**

| Method | Description |
|--------|-------------|
| `list_nat_gateways` | NAT Gateways with VPC/subnet placement and associated Elastic IPs |
| `list_load_balancers` | ALBs/NLBs with target group health, request counts, and type |
| `list_elastic_ips` | Unattached or idle Elastic IPs ($3.65/month each when unused) |
| `get_data_transfer_metrics` | CloudWatch metrics for NAT Gateway bytes processed and ALB request counts |

## Workflow: `@webframp/cost-audit`

### Inputs

```yaml
inputs:
  properties:
    region:
      type: string
      default: us-east-1
      description: AWS region to audit
    costPeriod:
      type: string
      default: 30d
      description: Cost Explorer lookback period (e.g., 30d, 90d)
    metricsTimeRange:
      type: string
      default: 7d
      description: CloudWatch metrics lookback (e.g., 7d, 14d)
  required: []
```

### Required Model Instances

```bash
swamp model create @webframp/aws/cost-explorer aws-costs --global-arg region=us-east-1
swamp model create @webframp/aws/networking aws-networking --global-arg region=us-east-1
swamp model create @webframp/aws/inventory aws-inventory --global-arg region=us-east-1
swamp model create @webframp/aws/cost-estimate aws-cost-est
```

### Job Structure

**Job 1: `gather-cost-and-resources`** (parallel steps)
- `get-cost-by-service` — Top-level spend breakdown (aws-costs)
- `get-cost-by-usage-type` — Drill into EC2-Other and data transfer (aws-costs)
- `get-cost-trend` — Daily cost time series (aws-costs)
- `inventory-all` — Running EC2, RDS, Lambda, etc. (aws-inventory)
- `list-nat-gateways` — NAT Gateways (aws-networking)
- `list-load-balancers` — ALBs/NLBs (aws-networking)
- `list-elastic-ips` — Unattached Elastic IPs (aws-networking)

**Job 2: `enrich-metrics`** (depends on job 1)
- `get-data-transfer-metrics` — BytesProcessed for each NAT Gateway and
  RequestCount for each ALB discovered in job 1. Identifies idle or
  low-traffic resources.

**Job 3: `deep-dive`** (depends on job 1)
- `get-top-cost-drivers` — Top 20 most expensive line items (aws-costs)

All steps use `allowFailure: true` so the report generates with partial data.

## Report: `@webframp/cost-audit-report`

Generates a markdown + JSON report with six sections:

### 1. Cost Summary
Top-level spend by service in a table. Total monthly cost and trend direction
(increasing/decreasing/stable) based on daily time series.

### 2. Top Cost Drivers
Top 20 line items by spend. Catches specific usage types like
`NatGateway-Bytes`, `DataTransfer-Regional-Bytes`, `ELB:LoadBalancerUsage`.

### 3. Networking Waste
Cross-references discovered resources with their metrics:
- NAT Gateways with low bytes processed vs. $32+/month baseline
- ALBs with low request counts vs. $16+/month baseline
- Unattached Elastic IPs at $3.65/month each

### 4. Infrastructure Inventory
Summary table of running resources — instance counts by type, RDS engines.
Context for understanding what drives spend.

### 5. Recommendations
Actionable items ranked by estimated monthly savings:
- "NAT Gateway `nat-0abc` processed 12MB last month — consider moving tasks
  to public subnet ($32/month savings)"
- "ALB `app-lb` served 847 requests last month — consider API Gateway HTTP
  API ($15/month savings)"
- "2 unattached Elastic IPs found ($7.30/month savings)"
- General: reserved instances or savings plans if on-demand spend is high

### 6. JSON Output
Structured data alongside the markdown for programmatic consumption.

## Implementation Order

1. `aws/cost-explorer` — new model extension with tests
2. `aws/networking` — new model extension with tests
3. `aws/cost-audit` — workflow + report + CI configuration
4. Update README with new extensions
