# @webframp/aws/networking

Inspect VPC networking resources that commonly generate hidden costs: NAT
Gateways, Load Balancers (ALB/NLB), and Elastic IPs. This extension queries the
AWS EC2, Elastic Load Balancing, and CloudWatch APIs to surface resource
inventories and data-transfer metrics so you can identify waste before it shows
up on the bill.

## Prerequisites

The extension uses the default AWS credential chain unless you set the
`profile` global argument, in which case credentials resolve via `fromIni`
(shared config, including SSO token cache). Your IAM principal must have the
following permissions:

- `ec2:DescribeNatGateways`
- `ec2:DescribeAddresses`
- `elasticloadbalancing:DescribeLoadBalancers`
- `elasticloadbalancing:DescribeTargetGroups`
- `elasticloadbalancing:DescribeTargetHealth`
- `cloudwatch:GetMetricStatistics`

## Quick Start

Create a model instance and run any of the four available methods. `region`
defaults to `us-east-1` if omitted — set it explicitly to the region whose
NAT Gateways, load balancers, and Elastic IPs you actually want to inspect,
since all four methods are regional:

```bash
swamp model create @webframp/aws/networking aws-networking \
  --global region=us-east-1

# Optional: use a named profile instead of the default credential chain
swamp model create @webframp/aws/networking aws-networking-prod \
  --global region=us-west-2 --global profile=prod-readonly

# List NAT Gateways with their Elastic IPs
swamp model method run aws-networking list_nat_gateways

# List ALBs/NLBs with target group health
swamp model method run aws-networking list_load_balancers

# Find unattached Elastic IPs (cost waste)
swamp model method run aws-networking list_elastic_ips
```

`list_nat_gateways` and `list_load_balancers` set a `truncated` flag in the
written resource when there are more pages than the extension fetched (see
Troubleshooting below) — check it before treating a count as complete.

## Data Transfer Metrics

The `get_data_transfer_metrics` method collects CloudWatch byte-transfer
statistics for NAT Gateways and request counts for Application Load Balancers
over a configurable lookback window:

```bash
# Default 7-day lookback, auto-discovers all NAT Gateways and load balancers
swamp model method run aws-networking get_data_transfer_metrics

# Custom 30-day lookback for specific NAT Gateways
swamp model method run aws-networking get_data_transfer_metrics \
  --arg days=30 \
  --arg natGatewayIds='["nat-0abc123"]'

# Scope to specific load balancers by name instead of discovering all of them
swamp model method run aws-networking get_data_transfer_metrics \
  --arg loadBalancerNames='["my-alb"]'
```

## Troubleshooting

- **Empty or unexpected results.** All four methods are regional, and
  `region` defaults to `us-east-1` if you don't set it (`GlobalArgsSchema` in
  `extensions/models/aws/networking.ts`). If your NAT Gateways or load
  balancers live in `us-west-2` or another region, a run with the default
  region silently returns zero resources rather than an error — always pass
  `--global region=<region>` explicitly for accounts outside `us-east-1`.

- **`list_nat_gateways` / `list_load_balancers` under-report on large
  accounts.** Both methods page through the AWS API up to `MAX_PAGES = 10`
  pages and then stop even if a `NextToken`/`NextMarker` is still present.
  When that happens the written resource's `truncated` field is `true` —
  check it in the resource data (`swamp model get aws-networking --json`)
  rather than trusting the returned count as a total.

- **`get_data_transfer_metrics` silently covers a partial fleet.** When you
  omit `natGatewayIds` or `loadBalancerNames`, the method auto-discovers
  resources using the same `MAX_PAGES = 10` capped pagination as above, but
  the discovery step does not surface a `truncated` flag in this method's
  output. On an account with more than ~250 NAT Gateways or load balancers,
  metrics may be collected for only a subset with no indication in the
  result — pass explicit `natGatewayIds` / `loadBalancerNames` if you need
  guaranteed full coverage.

- **Zero bytes/requests for a resource that clearly has traffic.**
  `get_data_transfer_metrics` sums CloudWatch `Datapoints` and falls back to
  `0` when a metric has no datapoints in the lookback window (`dp.Sum || 0`
  over a possibly-empty array). A NAT Gateway or ALB created partway through
  the lookback window, or one with metrics still propagating, will report
  `0` rather than an error — this is a CloudWatch data-availability gap, not
  a permissions problem.

- **`get_data_transfer_metrics` fails outright with an unfamiliar AWS
  error.** Passing a `loadBalancerNames` value that doesn't exist in the
  target region causes `DescribeLoadBalancersCommand` to throw (e.g.
  `LoadBalancerNotFoundException`), which this method wraps into `Failed to
  collect data-transfer metrics for region "<region>" over <days> day(s):
  <original message>` — the underlying AWS exception name is preserved in
  that trailing text, so check it for the real cause (typo'd name vs. wrong
  region vs. an actual permissions error).

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for the full text.
