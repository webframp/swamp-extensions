# @webframp/aws/cost-estimate

Calculate AWS infrastructure costs from inventory data or planned resource specifications.
This swamp model extension queries the AWS Pricing API for real-time On-Demand rates
and produces monthly cost estimates for EC2 and RDS resources.

## Features

- Estimate EC2 compute costs from live inventory gathered by `@webframp/aws/inventory`
- Estimate RDS costs (compute + storage) from live inventory data
- Pre-deployment cost estimation from a declarative resource specification
- Price caching within a single run to minimize API calls
- Support for all major AWS regions via the Pricing API location mapping

## Authentication

Uses the default AWS credential chain. The Pricing API serves public pricing
data but still requires valid AWS credentials. Only two regions host the
Pricing API endpoint: `us-east-1` and `ap-south-1`.

## Usage

### Estimate costs from existing inventory

First gather inventory with `@webframp/aws/inventory`, then pass the data
to the cost estimate model:

```bash
# Create model instances
swamp model create @webframp/aws/inventory aws-inv --global-arg region=us-east-1
swamp model create @webframp/aws/cost-estimate cost-est

# Gather EC2 inventory
swamp model method run aws-inv list_ec2

# Extract inventory JSON and estimate costs
EC2_DATA=$(swamp data get aws-inv ec2-us-east-1 --json | jq '.data.resources')
swamp model method run cost-est estimate_ec2 --input "inventory=${EC2_DATA}"
```

### Estimate costs for planned infrastructure

Provide a resource specification before deploying anything:

```bash
swamp model method run cost-est estimate_from_spec \
  --input 'ec2Instances=[{"name":"web","instanceType":"t3.medium","count":3}]' \
  --input 'rdsInstances=[{"name":"db","dbInstanceClass":"db.t3.medium","engine":"postgres","storageGb":100}]'
```

## Methods

| Method               | Description                                      |
| -------------------- | ------------------------------------------------ |
| `estimate_ec2`       | Estimate EC2 costs from inventory data            |
| `estimate_rds`       | Estimate RDS costs from inventory data            |
| `estimate_from_spec` | Estimate costs for planned resources (pre-deploy) |

## Pricing Notes

- All rates are On-Demand; Reserved Instance and Savings Plan discounts are not applied.
- EC2 estimates cover compute hours only (no EBS volumes or data transfer).
- RDS estimates include compute hours plus storage at the gp2 default rate of $0.115/GB-month.
- Monthly estimates assume 730 hours per month.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md).
