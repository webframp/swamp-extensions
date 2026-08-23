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
  --global-arg region=us-east-1

# Spend breakdown by service (last 30 days)
swamp model method run aws-costs get_cost_by_service

# Drill into a specific service's usage types
# `service` must match the exact name Cost Explorer uses (as returned by
# get_cost_by_service), not the console/marketing name — "EC2" will not match.
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

Each method writes to its own typed resource (`costTrend`, `costByService`,
`costByUsageType`, `costDrivers`, `costComparison`), all with a 1-hour
lifetime and garbage collection retaining the last 10 entries per spec.

## Troubleshooting

**`get_cost_by_usage_type` returns an empty `usageTypes` array, no error** —
`service` is passed straight into a Cost Explorer `Dimensions` filter
(`Filter: { Dimensions: { Key: "SERVICE", Values: [args.service] } }`). A
name that doesn't match Cost Explorer's exact service string (e.g. `"EC2"`
instead of `"Amazon Elastic Compute Cloud - Compute"`) matches nothing and
the API happily returns zero groups — there's no validation against a known
service list. Run `get_cost_by_service` first and copy the `service` value
verbatim.

**Changing `region` away from `us-east-1` breaks every method** — the
`region` global argument defaults to `us-east-1`
(`extensions/models/aws/cost_explorer.ts`) because AWS Cost Explorer's
`GetCostAndUsage` API is only served from that region regardless of where
your resources actually run. Overriding it (`--global-arg region=eu-west-1`)
produces an SDK-level connection/endpoint failure, not a permissions error —
if you see that, revert to `us-east-1` rather than debugging IAM.

**Errors always include the underlying AWS message and the query period** —
every method wraps SDK failures as, e.g., `` GetCostAndUsage (group by
SERVICE) failed for period 2026-07-01..2026-07-31: <original message> ``. If
the original message is an `AccessDeniedException`, the model instance's
credentials are missing the `ce:GetCostAndUsage` IAM permission listed in
Prerequisites. If it mentions data availability, Cost Explorer has not yet
finalized billing data for part of the requested window (recent AWS billing
data typically lags by up to 24 hours) — narrow `days` or retry later rather
than treating it as an auth problem.

**`get_cost_trend` reports `trend: "stable"` for very short windows** —
trend direction only gets computed when there are at least two daily data
points to compare (`dataPoints.length >= 2` in `get_cost_trend`); with
`days=1` there's only one data point and the method always reports
`"stable"` regardless of actual spend change. Use `days >= 2` if you need a
real increasing/decreasing signal.

**`get_cost_comparison` issues two Cost Explorer API calls, not one** —
unlike the other four methods, it queries the current and previous periods
as two sequential `GetCostAndUsageCommand` calls on the same client. Each
Cost Explorer API call is separately billed by AWS and counts against the
same request-rate limit, so running this method is roughly twice the
cost/latency of the others per invocation.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
