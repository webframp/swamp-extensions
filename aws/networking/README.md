# @webframp/aws/networking

Inspect VPC networking resources that commonly generate hidden costs: NAT Gateways,
Load Balancers (ALB/NLB), and Elastic IPs. This extension queries the AWS EC2,
Elastic Load Balancing, and CloudWatch APIs to surface resource inventories and
data-transfer metrics so you can identify waste before it shows up on the bill.

## Prerequisites

The extension uses the default AWS credential chain. Your IAM principal must have
the following permissions:

- `ec2:DescribeNatGateways`
- `ec2:DescribeAddresses`
- `elasticloadbalancing:DescribeLoadBalancers`
- `elasticloadbalancing:DescribeTargetGroups`
- `elasticloadbalancing:DescribeTargetHealth`
- `cloudwatch:GetMetricStatistics`

## Quick Start

Create a model instance and run any of the four available methods:

```bash
swamp model create @webframp/aws/networking aws-networking \
  --global region=us-east-1

# List NAT Gateways with their Elastic IPs
swamp model method run aws-networking list_nat_gateways

# List ALBs/NLBs with target group health
swamp model method run aws-networking list_load_balancers

# Find unattached Elastic IPs (cost waste)
swamp model method run aws-networking list_elastic_ips
```

## Data Transfer Metrics

The `get_data_transfer_metrics` method collects CloudWatch byte-transfer statistics
for NAT Gateways and request counts for Application Load Balancers over a
configurable lookback window:

```bash
# Default 7-day lookback
swamp model method run aws-networking get_data_transfer_metrics

# Custom 30-day lookback for specific resources
swamp model method run aws-networking get_data_transfer_metrics \
  --arg days=30 \
  --arg natGatewayIds='["nat-0abc123"]'
```

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for the full text.
