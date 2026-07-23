# @webframp/elasticache-datastore-bootstrap

One-shot bootstrap for `@webframp/valkey-datastore` targeting AWS ElastiCache
Serverless. Creates a serverless Valkey cache, a VPC security group, and a
scoped IAM managed policy, then configures the current swamp repository.

For local Valkey/Redis development, configure `@webframp/valkey-datastore`
directly — this bootstrap is specifically for the AWS managed service.

## Prerequisites

- AWS credentials (environment, profile, or attached role) with permissions to:
  - `elasticache:CreateServerlessCache`, `elasticache:DescribeServerlessCaches`
  - `ec2:CreateSecurityGroup`, `ec2:AuthorizeSecurityGroupIngress`,
    `ec2:DescribeSecurityGroups`, `ec2:DescribeVpcs`, `ec2:DescribeSubnets`,
    `ec2:CreateTags`
  - `iam:CreatePolicy`, `iam:GetPolicy`
  - `sts:GetCallerIdentity`
- The AWS CLI (`aws`) available on `PATH`
- A VPC with subnets (uses default VPC if not specified)

## Usage

```bash
swamp extension pull @webframp/elasticache-datastore-bootstrap

# Create provisioner + shell model instances
swamp model create @webframp/elasticache-datastore-bootstrap/provisioner \
  swamp-valkey-provisioner
swamp model create command/shell swamp-valkey-setup

# Run the bootstrap workflow
swamp workflow run @webframp/bootstrap-elasticache-datastore \
  --input region=us-east-1

# Verify
swamp datastore status
```

## Inputs

| Input                 | Default                      | Description                       |
| --------------------- | ---------------------------- | --------------------------------- |
| `region`              | `us-east-1`                  | AWS region                        |
| `cache_name`          | `swamp-valkey`               | ElastiCache Serverless cache name |
| `vpc_id`              | (default VPC)                | VPC to deploy into                |
| `subnet_ids`          | (all VPC subnets)            | Comma-separated subnet IDs        |
| `security_group_name` | `swamp-valkey-access`        | SG name for cache access          |
| `policy_name`         | `SwampValkeyDatastorePolicy` | IAM policy name                   |
| `key_prefix`          | `swamp`                      | Valkey key namespace prefix       |

## What gets created

### ElastiCache Serverless Cache

- **Engine:** Valkey
- **TLS:** Enabled by default (ElastiCache Serverless enforces TLS)
- **Endpoint:** `rediss://<host>:6379`
- **Billing:** Serverless (pay per data stored + ECPUs consumed)

### Security Group

- Allows TCP/6379 inbound from the VPC CIDR block
- Tagged with `ManagedBy=swamp`

### IAM Managed Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "elasticache:Connect",
        "elasticache:DescribeServerlessCaches"
      ],
      "Resource": [
        "arn:aws:elasticache:<region>:<account>:serverlesscache:<name>"
      ]
    }
  ]
}
```

## Idempotency

The provisioner is fully idempotent:

- If the cache already exists and is available, it is reused
- If the security group already exists in the VPC, it is reused
- If the IAM policy already exists, its ARN is returned
- Re-running safely overwrites the datastore configuration

## Timing

ElastiCache Serverless cache creation takes 2-5 minutes. The provisioner polls
every 15 seconds with a 10-minute timeout.

## Development

```bash
cd valkey-datastore-bootstrap
~/.swamp/deno/deno task check
~/.swamp/deno/deno task test
```
