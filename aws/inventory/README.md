# @webframp/aws/inventory

Discover running AWS resources for cost estimation and inventory management.
This swamp extension queries multiple AWS services to build a unified view of
your cloud infrastructure, covering EC2 instances, RDS databases, DynamoDB
tables, Lambda functions, S3 buckets, and EBS volumes.

## Authentication

Uses the default AWS credential chain. Ensure your environment has valid
credentials configured (environment variables, shared credentials file, or an
instance profile). The IAM principal must hold the permissions listed below.

### Required IAM Permissions

- `ec2:DescribeInstances`
- `ec2:DescribeVolumes`
- `rds:DescribeDBInstances`
- `dynamodb:ListTables`, `dynamodb:DescribeTable`
- `lambda:ListFunctions`
- `s3:ListBuckets`

## Installation

```bash
swamp extension pull @webframp/aws/inventory
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

| Method          | Description                                       |
| --------------- | ------------------------------------------------- |
| `list_ec2`      | List EC2 instances filtered by state              |
| `list_rds`      | List RDS database instances                       |
| `list_dynamodb` | List DynamoDB tables with capacity details        |
| `list_lambda`   | List Lambda functions                             |
| `list_s3`       | List S3 buckets (global, ignores region setting)  |
| `list_ebs`      | List EBS volumes with attachment status           |
| `inventory_all` | Run full inventory across all supported resources |

## Troubleshooting

### Global arg is `regions` (array), not `region` (string)

The model expects `--global-arg regions='["us-east-1"]'` (an array). A bare
`--global-arg region=us-east-1` will fail Zod validation. This was changed in
version `2026.06.24.1` — the old `region` (string) schema no longer works.

### `inventory_scan` and `inventory_diff` only use the first region

These methods explicitly use `regions[0]` regardless of how many regions are
configured. Multi-region scanning requires separate model instances or using
`inventory_all` which fans out across all configured regions.

### Resource Explorer / Config fallback is silent

The `inventory_scan` method tries Resource Explorer 2 first, then AWS Config,
then the Tag API. If RE2 or Config fails (not enabled, missing permissions,
throttled), the method silently falls through to the next source. The
`sourceNote` field in the output indicates which source was used, but no warning
is emitted about failed attempts.

### `MAX_PAGES = 10` truncation (per-service methods)

Individual methods (`list_ec2`, `list_rds`, etc.) cap pagination at 10 pages.
Per-page sizes vary: EC2 returns up to 1,000 per page (~10,000 max), Lambda
returns 50 (~500 max), RDS returns 100 (~1,000 max). The `truncated` field is
set when the cap is reached.

### `inventory_diff` shows empty diff on first run

Without a previous baseline resource, the diff method sets `noBaseline: true`
and produces empty `added`/`removed` arrays. Run `inventory_scan` at least twice
(with a gap) to produce meaningful diffs. Source mismatches between runs also
suppress diff output to prevent false positives.

### S3 listing uses only the first region

`list_s3` calls the global `ListBuckets` API using `regions[0]` as the endpoint.
It returns all buckets regardless of where they were created.

### `list_lambda` reserved concurrency silently null

Per-function `GetFunctionConcurrency` failures are silently caught.
`reservedConcurrency: null` is indistinguishable from "no reserved concurrency
configured."

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for details.
