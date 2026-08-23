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

## Troubleshooting

**`Multiple default VPCs found (<n>) — provide vpc_id explicitly`**
Unlike some AWS resources, `getDefaultVpcId` treats more than one VPC tagged
`is-default` as an error rather than picking the first — this can happen in
accounts with cross-region default VPCs visible through certain
organization/IAM setups. Pass `vpc_id` explicitly rather than relying on
default-VPC resolution.

**`ElastiCache Serverless cache <name> creation failed` /
`... is in terminal state: deleting` or `deleted`**
`waitForCacheAvailable` distinguishes these terminal states from a plain
timeout: `create-failed` means AWS rejected the cache (check the AWS console
for the underlying reason, often a subnet/security-group mismatch),
while `deleting`/`deleted` means something else deleted the cache out from
under a concurrent bootstrap run. Both fail fast instead of polling the full
10-minute window.

**Re-running the bootstrap silently adds a missing ingress rule**
`ensureSecurityGroup` doesn't just check whether the security group exists —
it also inspects `IpPermissions` for a TCP/6379 rule covering the cache port
and adds one if missing. This is intentional self-healing for a security
group left in a partial state by an earlier failed run, but it means a
security group you deliberately locked down to a narrower CIDR will have its
6379 rule reopened to the full VPC CIDR on the next `provision` call.

**Reported `securityGroupId` doesn't match the one this bootstrap manages**
When reusing an existing cache, the provisioner reports the security group
actually attached to the cache (`cache.SecurityGroupIds[0]`) rather than the
one it resolved from `security_group_name` — if the cache was originally
created with a different security group (e.g., by hand or by a previous
bootstrap run with different arguments), the two can diverge. This is
expected: it reflects the cache's real configuration, not a bug in name
resolution.

## Development

```bash
cd elasticache-datastore-bootstrap
~/.swamp/deno/deno task check
~/.swamp/deno/deno task test
```
