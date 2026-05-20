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
