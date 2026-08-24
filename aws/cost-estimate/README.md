# @webframp/aws/cost-estimate

Calculate AWS infrastructure costs from inventory data or planned resource
specifications. This swamp model extension queries the AWS Pricing API for
real-time On-Demand rates and produces monthly cost estimates for EC2 and RDS
resources.

## Features

- Estimate EC2 compute costs from live inventory gathered by
  `@webframp/aws/inventory`
- Estimate RDS costs (compute + storage) from live inventory data
- Pre-deployment cost estimation from a declarative resource specification
- Price caching within a single run to minimize API calls
- Support for all major AWS regions via the Pricing API location mapping

## Authentication

Uses the default AWS credential chain. The Pricing API serves public pricing
data but still requires valid AWS credentials. Only two regions host the Pricing
API endpoint: `us-east-1` and `ap-south-1`.

## Usage

### Estimate costs from existing inventory

First gather inventory with `@webframp/aws/inventory`, then pass the data to the
cost estimate model:

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

| Method               | Description                                       |
| -------------------- | ------------------------------------------------- |
| `estimate_ec2`       | Estimate EC2 costs from inventory data            |
| `estimate_rds`       | Estimate RDS costs from inventory data            |
| `estimate_from_spec` | Estimate costs for planned resources (pre-deploy) |

## Pricing Notes

- All rates are On-Demand; Reserved Instance and Savings Plan discounts are not
  applied.
- EC2 estimates cover compute hours only (no EBS volumes or data transfer).
- RDS estimates include compute hours plus storage at the gp2 default rate of
  $0.115/GB-month.
- Monthly estimates assume 730 hours per month.

## Troubleshooting

### Instance type shows $0/month estimate

The pricing helpers return `0` when the AWS Pricing API has no matching product.
Common causes:

- **Unmapped region:** The internal `regionToLocation` mapping covers 17
  regions. Newer regions (Milan, Cape Town, Hong Kong, Jakarta, Tel Aviv, etc.)
  fall back to the raw region code, which does not match any Pricing API
  location string. The estimate silently returns zero.
- **Platform mismatch:** Only `"linux"` and `"windows"` are recognized. RHEL,
  SUSE, and other licensed platforms are priced as Linux (incorrect but
  non-failing).
- **Typo in instance type:** The Pricing API filter uses the exact instance type
  string. A typo like `"t3.mirco"` produces zero matches and a $0 rate.

No warning is logged when a price lookup returns zero. The `totalMonthly` field
will be understated if any items were unpriced.

### `estimate_rds` uses us-east-1 pricing when availability zone is null

If the inventory data for an RDS instance lacks an `availabilityZone` (common
for Multi-AZ deployments where the primary AZ is not exposed), the pricing
lookup defaults to `us-east-1` regardless of the instance's actual region.
Cross-region pricing differences are not reflected.

### `pricingRegion` global arg

The Pricing API exists only in `us-east-1` and `ap-south-1`. The `pricingRegion`
global arg controls which endpoint is used. The default (`us-east-1`) is correct
for most users. Pass `--global-arg pricingRegion=ap-south-1` for lower latency
from the Asia-Pacific region.

### `estimate_from_spec` rejects empty input

At least one of `ec2Instances` or `rdsInstances` must be non-empty. Passing both
as empty arrays fails Zod validation.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md).
