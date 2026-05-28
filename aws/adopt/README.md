# @webframp/aws/adopt

Brownfield adoption of existing AWS infrastructure into swamp models. Discovers
VPCs, subnets, gateways, route tables, security groups, RDS clusters, RDS
instances, DB subnet groups, and Secrets Manager secrets via native SDK calls,
then generates the setup commands and workflow needed to bring them under
management.

## Authentication

This extension uses the default AWS credential chain. Export `AWS_PROFILE` and
`AWS_REGION` before running any discovery methods:

```bash
export AWS_PROFILE=my-account-ReadOnlyPlus
export AWS_REGION=us-east-1
```

The profile must have read access to EC2, RDS, and Secrets Manager in the target
region.

## Quick Start

```bash
# Install the extension
swamp extension pull @webframp/aws/adopt

# Create a discovery model scoped to a VPC
swamp model create @webframp/aws/adopt my-discovery \
  --global-arg region=us-east-1 \
  --global-arg vpcId=vpc-0b4f6dd0dfd8c5339

# Run full discovery
swamp model method run my-discovery discover_all --arg prefix=swamp-pg-test

# Execute the generated setup commands (from discover_all output)
swamp model create @swamp/aws/ec2/vpc swamp-pg-test-vpc-0dfd8c5339 \
  --global-arg 'name=swamp-pg-test-vpc-0dfd8c5339' \
  --global-arg 'CidrBlock=10.0.0.0/16'
# ... (repeat for each resource in setupCommands)

# Run the adoption workflow
swamp workflow run @webframp/adopt-stack \
  --input vpcId=vpc-0b4f6dd0dfd8c5339 \
  --input clusterIdentifier=my-cluster \
  --input prefix=swamp-pg-test

# View the adoption report
swamp report get @webframp/adopt-report --latest
```

## Discovery Methods

| Method                      | Description                                              |
| --------------------------- | -------------------------------------------------------- |
| `discover_all`              | Full discovery with setup commands and workflow guidance |
| `discover_vpcs`             | Discover existing VPCs                                   |
| `discover_subnets`          | Discover existing subnets                                |
| `discover_gateways`         | Discover existing internet gateways                      |
| `discover_route_tables`     | Discover existing route tables                           |
| `discover_security_groups`  | Discover existing security groups                        |
| `discover_rds_clusters`     | Discover existing RDS clusters                           |
| `discover_rds_instances`    | Discover existing RDS instances                          |
| `discover_db_subnet_groups` | Discover existing DB subnet groups                       |
| `discover_secrets`          | Discover existing Secrets Manager secrets                |

All methods respect the `vpcId` global argument for filtering EC2 resources. RDS
and Secrets Manager methods discover all resources in the region regardless of
VPC filter.

## CloudFormation Stack Adoption

For environments managed by CloudFormation, `plan_stack_adoption` enumerates a
stack's resources and produces an adoption plan that maps each `AWS::*` type to
its corresponding `@swamp/aws/*` model.

### Method

| Method                | Description                                                    |
| --------------------- | -------------------------------------------------------------- |
| `plan_stack_adoption` | Map all stack resources (recursive into nested) to swamp types |

Inputs:

- `stackName` (required): CloudFormation stack name or ID
- `includeNested` (default: `true`): recurse into `AWS::CloudFormation::Stack`
  children
- `maxDepth` (default: `3`): nested stack recursion limit
- `prefix` (default: `adopt`): prefix for generated swamp model names

Output (stored as the `stackPlan` resource):

- `mapped[]` — resources with a known swamp type, including pre-built
  `setupCommandTemplate` (requires additional global-args per type) and
  `getCommand` strings
- `unmapped[]` — resources with no swamp equivalent (e.g.,
  `AWS::Kinesis::Stream`, `Custom::*` resources)
- `skipped[]` — resources in unstable states (`CREATE_IN_PROGRESS`,
  `DELETE_IN_PROGRESS`, etc.) where `PhysicalResourceId` is unreliable
- `orphans[]` — resources from a previous plan that are missing from the
  current stack (compared against the previous run's plan stored in this
  model)
- `summary` — counts and `coveragePercent`

### Workflow

`@webframp/adopt-cfn-stack` orchestrates the two-phase adoption:

```bash
swamp workflow run @webframp/adopt-cfn-stack \
  --input modelName=my-adopt \
  --input stackName=my-prod-stack
```

The workflow produces the plan, then runs `get` on each mapped resource's
swamp model. Models that don't yet exist will surface as failed steps (with
`allowFailure: true` so the workflow continues). Inspect the plan output, use
the `setupCommandTemplate` strings as a starting point (adding required
global-args per type via `swamp model type describe <type>`), then re-run
the workflow — on the second pass, all `get` calls succeed and live state is
captured.

### Supported CloudFormation types

| `AWS::*` type                 | Maps to `@swamp/*` type            |
| ----------------------------- | ---------------------------------- |
| `AWS::EC2::VPC`               | `@swamp/aws/ec2/vpc`               |
| `AWS::EC2::Subnet`            | `@swamp/aws/ec2/subnet`            |
| `AWS::EC2::InternetGateway`   | `@swamp/aws/ec2/internet-gateway`  |
| `AWS::EC2::RouteTable`        | `@swamp/aws/ec2/route-table`       |
| `AWS::EC2::SecurityGroup`     | `@swamp/aws/ec2/security-group`    |
| `AWS::EC2::NatGateway`        | `@swamp/aws/ec2/nat-gateway`       |
| `AWS::EC2::EIP`               | `@swamp/aws/ec2/eip`               |
| `AWS::RDS::DBCluster`         | `@swamp/aws/rds/dbcluster`         |
| `AWS::RDS::DBInstance`        | `@swamp/aws/rds/dbinstance`        |
| `AWS::RDS::DBSubnetGroup`     | `@swamp/aws/rds/dbsubnet-group`    |
| `AWS::SecretsManager::Secret` | `@swamp/aws/secretsmanager/secret` |
| `AWS::S3::Bucket`             | `@swamp/aws/s3/bucket`             |
| `AWS::Lambda::Function`       | `@swamp/aws/lambda/function`       |
| `AWS::IAM::Role`              | `@swamp/aws/iam/role`              |
| `AWS::CloudFormation::Stack`  | _recursed, not adopted as a model_ |

Adding a new type is a one-line PR to `CFN_TO_SWAMP_TYPE_MAP` in `adopt.ts`.

## Model Naming Convention

Generated model names follow the pattern:

```
{prefix}-{type-short}-{identifier-suffix}
```

Examples:

- `swamp-pg-test-vpc-0dfd8c5339` (last 9 characters of the VPC ID)
- `swamp-pg-test-subnet-0a1b2c3d4` (last 9 characters of the subnet ID)
- `swamp-pg-test-rds-my-cluster` (full cluster identifier)
- `swamp-pg-test-secret-db-creds` (full secret name)

EC2 resources use the last 9 characters of the resource ID as the suffix. RDS
and Secrets Manager resources use the full identifier or name.

## IAM Permissions Required

**Discovery (read-only):**

- `ec2:DescribeVpcs`
- `ec2:DescribeSubnets`
- `ec2:DescribeInternetGateways`
- `ec2:DescribeRouteTables`
- `ec2:DescribeSecurityGroups`
- `rds:DescribeDBClusters`
- `rds:DescribeDBInstances`
- `rds:DescribeDBSubnetGroups`
- `secretsmanager:ListSecrets`
- `cloudformation:ListStackResources` (for `plan_stack_adoption` only)

**Management (workflow adoption):**

- All discovery permissions above
- `ec2:DescribeVpcAttribute`
- `rds:DescribeDBClusterEndpoints`
- `rds:ListTagsForResource`
- `secretsmanager:DescribeSecret`

## Dependencies

- `@swamp/aws/ec2@2026.04.03.2`
- `@swamp/aws/rds@2026.04.23.2`
- `@swamp/aws/secretsmanager@2026.05.18.1`
