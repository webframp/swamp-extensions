# @webframp/aws/inventory

Discover running AWS resources for cost estimation and inventory management.
This swamp extension queries multiple AWS services to build a unified view of
your cloud infrastructure, covering EC2 instances, RDS databases, DynamoDB
tables, Lambda functions, S3 buckets, and EBS volumes.

## Authentication

Uses the default AWS credential chain. Ensure your environment has valid
credentials configured (environment variables, shared credentials file, or
an instance profile). The IAM principal must hold the permissions listed below.

### Required IAM Permissions

- `ec2:DescribeInstances`
- `ec2:DescribeVolumes`
- `rds:DescribeDBInstances`
- `dynamodb:ListTables`, `dynamodb:DescribeTable`
- `lambda:ListFunctions`
- `s3:ListBuckets`

## Installation

```bash
swamp extension install @webframp/aws/inventory
```

## Usage

Create an inventory model instance, then run individual or combined methods:

```bash
# Create the model instance scoped to a region
swamp model create @webframp/aws/inventory aws-inv \
  --global region=us-east-1

# List running EC2 instances
swamp model method run aws-inv list_ec2

# List RDS databases
swamp model method run aws-inv list_rds

# List DynamoDB tables
swamp model method run aws-inv list_dynamodb

# List Lambda functions
swamp model method run aws-inv list_lambda

# List S3 buckets (global)
swamp model method run aws-inv list_s3

# List EBS volumes
swamp model method run aws-inv list_ebs

# Full inventory across all resource types
swamp model method run aws-inv inventory_all
```

## Methods

| Method           | Description                                      |
|------------------|--------------------------------------------------|
| `list_ec2`       | List EC2 instances filtered by state              |
| `list_rds`       | List RDS database instances                       |
| `list_dynamodb`  | List DynamoDB tables with capacity details         |
| `list_lambda`    | List Lambda functions                             |
| `list_s3`        | List S3 buckets (global, ignores region setting)   |
| `list_ebs`       | List EBS volumes with attachment status            |
| `inventory_all`  | Run full inventory across all supported resources  |

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for details.
