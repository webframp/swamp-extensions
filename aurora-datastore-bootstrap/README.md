# @webframp/aurora-datastore-bootstrap

One-shot bootstrap for `@webframp/postgres-datastore` targeting AWS Aurora
Serverless v2 (PostgreSQL). Creates a cluster with a serverless writer instance,
networking primitives, and a scoped IAM managed policy, then configures the
current swamp repository.

## Prerequisites

- AWS credentials with permissions to create RDS resources, EC2 security groups,
  DB subnet groups, and IAM policies
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

| Input                 | Default                      | Description                         |
| --------------------- | ---------------------------- | ----------------------------------- |
| `region`              | `us-east-1`                  | AWS region                          |
| `cluster_identifier`  | `swamp-datastore`            | Aurora cluster name                 |
| `instance_identifier` | `swamp-datastore-writer`     | Writer instance name                |
| `master_username`     | `swamp`                      | Database master user                |
| `master_password`     | _(required)_                 | Master password (8+ chars)          |
| `database_name`       | `swamp`                      | Initial database                    |
| `vpc_id`              | (default VPC)                | VPC to deploy into                  |
| `subnet_ids`          | (all VPC subnets)            | 2+ subnets in different AZs         |
| `security_group_name` | `swamp-aurora-access`        | SG name                             |
| `subnet_group_name`   | `swamp-aurora-subnets`       | DB subnet group name                |
| `policy_name`         | `SwampAuroraDatastorePolicy` | IAM policy name                     |
| `min_acu`             | `0.5`                        | Minimum capacity (scales near zero) |
| `max_acu`             | `8`                          | Maximum capacity                    |

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
      "Resource": [
        "<cluster-arn>",
        "arn:aws:rds:<region>:<account>:db:<cluster>-*"
      ]
    }
  ]
}
```

## Idempotency

All resources are checked before creation. Re-running is safe.

## Timing

Aurora cluster creation takes 5-10 minutes. The provisioner polls every 15
seconds with a 10-minute timeout.

## Troubleshooting

**`No default VPC found — provide vpc_id explicitly`**
`getDefaultVpcId` only runs when `vpc_id` is omitted, and looks for a VPC
tagged `is-default,Values=true`. Accounts where the default VPC was deleted
(common in security-hardened accounts) have none — pass `vpc_id` explicitly.

**`Need at least 2 subnets in different AZs for Aurora, found <n> in VPC
<vpc_id>`**
`getSubnetIds` fetches every subnet in the resolved VPC and fails outright if
fewer than 2 come back. Aurora's DB subnet group requires multi-AZ coverage
even for a single-instance serverless writer — if your default VPC only has
subnets in one AZ, pass `subnet_ids` pointing at subnets in at least two AZs.

**`Cluster <id> did not become available within 600s`**
`waitForClusterAvailable` polls `describe-db-clusters` every 15 seconds for
up to 10 minutes and throws on timeout — consistent with the README's stated
5–10 minute creation window, so a timeout here usually means something is
genuinely stuck (e.g., a subnet group or security group misconfiguration),
not just AWS running slow. Re-running `provision` resumes waiting on the
existing cluster rather than trying to create it again.

**Cluster reports `available` but connections still fail immediately after
provisioning**
The provisioner only polls the *cluster's* status to `available`; the writer
instance is created via a separate `create-db-instance` call with no
corresponding wait or status check. A cluster can go `available` slightly
before its writer instance finishes provisioning and starts accepting
connections on port 5432 — if the datastore's first connection attempt fails
right after bootstrap, wait a short interval and retry rather than assuming
the security group or credentials are wrong.

**`rds-db:connect` denied even though the IAM policy was created**
The generated policy scopes `rds-db:connect` to
`dbuser:*/<master_username>` — it authorizes IAM-auth connections only as the
master username configured at bootstrap time. If `@webframp/postgres-datastore`
is later configured to connect as a different database user via IAM auth,
this policy won't cover it; either connect as `master_username` or broaden
the policy's `Resource`.

## Development

```bash
cd aurora-datastore-bootstrap
~/.swamp/deno/deno task check
~/.swamp/deno/deno task test
```
