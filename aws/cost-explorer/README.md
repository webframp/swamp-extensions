# @webframp/aws/cost-explorer

A swamp extension that queries AWS Cost Explorer to analyze actual cloud spend
by service, usage type, and time period. It identifies top cost drivers, tracks
daily spend trends, and compares costs between periods to surface anomalies and
optimization opportunities.

## Prerequisites

- AWS credentials configured via the default credential chain
- IAM permission: `ce:GetCostAndUsage`

## Installation

```bash
swamp extension install @webframp/aws/cost-explorer
```

## Quick Start

Create a model instance and run cost analysis methods:

```bash
# Create model instance
swamp model create @webframp/aws/cost-explorer aws-costs \
  --global region=us-east-1

# Spend breakdown by service (last 30 days)
swamp model method run aws-costs get_cost_by_service

# Drill into a specific service's usage types
swamp model method run aws-costs get_cost_by_usage_type \
  --input service="Amazon Elastic Compute Cloud - Compute"

# Daily cost trend over the last 30 days
swamp model method run aws-costs get_cost_trend --input days=30

# Top 20 cost drivers by service and usage type
swamp model method run aws-costs get_top_cost_drivers

# Compare current period costs against previous period
swamp model method run aws-costs get_cost_comparison --input days=30
```

## Methods

| Method                   | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `get_cost_by_service`    | Break down spend by AWS service over a given period      |
| `get_cost_by_usage_type` | Drill into a single service's spend by usage type        |
| `get_cost_trend`         | Show daily cost trend and detect spend direction         |
| `get_top_cost_drivers`   | Identify top cost drivers by service and usage type      |
| `get_cost_comparison`    | Compare current period costs against the previous period |

## Resources

All methods write results to the `costs` resource with a 1-hour lifetime and
garbage collection retaining the last 10 entries.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
