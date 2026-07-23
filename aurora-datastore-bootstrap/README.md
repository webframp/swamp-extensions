# @webframp/aurora-datastore-bootstrap

One-shot bootstrap for `@webframp/postgres-datastore` targeting AWS Aurora
Serverless v2 (PostgreSQL). Creates a cluster with a serverless writer
instance, networking primitives, and a scoped IAM managed policy, then
configures the current swamp repository.

## Prerequisites

- AWS credentials with permissions to create RDS resources, EC2 security
  groups, DB subnet groups, and IAM policies
- AWS CLI (`aws`) on `PATH`
- A VPC with at least 2 subnets in different AZs

## Usage

```bash
swamp extension pull @webframp/aurora-datastore-bootstrap

swamp model create @webframp/aurora-datastore-bootstrap/provisioner \
  swamp-aurora-provisioner
swamp model create command/shell swamp-aurora-setup

swamp workflow run @webframp/bootstrap-aurora-datastore \
  --input region=us-east-1 \
  --input master_password=YourSecurePass123

swamp datastore status
```

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `region` | `us-east-1` | AWS region |
| `cluster_identifier` | `swamp-datastore` | Aurora cluster name |
| `instance_identifier` | `swamp-datastore-writer` | Writer instance name |
| `master_username` | `swamp` | Database master user |
| `master_password` | *(required)* | Master password (8+ chars) |
| `database_name` | `swamp` | Initial database |
| `vpc_id` | (default VPC) | VPC to deploy into |
| `subnet_ids` | (all VPC subnets) | 2+ subnets in different AZs |
| `security_group_name` | `swamp-aurora-access` | SG name |
| `subnet_group_name` | `swamp-aurora-subnets` | DB subnet group name |
| `policy_name` | `SwampAuroraDatastorePolicy` | IAM policy name |
| `min_acu` | `0.5` | Minimum capacity (scales near zero) |
| `max_acu` | `8` | Maximum capacity |

## What gets created

### Aurora Serverless v2 Cluster

- **Engine:** aurora-postgresql 16.4
- **Scaling:** 0.5–8 ACU (configurable)
- **IAM auth:** enabled
- **Encryption:** at rest (default KMS key)
- **Endpoint:** `<cluster>.cluster-xxx.<region>.rds.amazonaws.com:5432`

### Networking

- **DB subnet group** spanning provided (or default VPC) subnets
- **Security group** allowing TCP/5432 inbound from VPC CIDR

### IAM Managed Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SwampAuroraConnect",
      "Effect": "Allow",
      "Action": "rds-db:connect",
      "Resource": "arn:aws:rds-db:<region>:<account>:dbuser:*/<username>"
    },
    {
      "Sid": "SwampAuroraDescribe",
      "Effect": "Allow",
      "Action": ["rds:DescribeDBClusters", "rds:DescribeDBInstances"],
      "Resource": ["<cluster-arn>", "arn:aws:rds:<region>:<account>:db:<cluster>-*"]
    }
  ]
}
```

## Idempotency

All resources are checked before creation. Re-running is safe.

## Timing

Aurora cluster creation takes 5-10 minutes. The provisioner polls every
15 seconds with a 10-minute timeout.

## Development

```bash
cd aurora-datastore-bootstrap
~/.swamp/deno/deno task check
~/.swamp/deno/deno task test
```
