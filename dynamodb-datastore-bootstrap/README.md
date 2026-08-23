# @webframp/dynamodb-datastore-bootstrap

One-shot bootstrap for `@webframp/dynamodb-datastore`. Creates a DynamoDB table
and a scoped IAM managed policy, then configures the current swamp repository to
use DynamoDB as its datastore.

## Prerequisites

- AWS credentials (environment, profile, or attached role) with permissions to:
  - `dynamodb:CreateTable`, `dynamodb:DescribeTable`,
    `dynamodb:UpdateTimeToLive`, `dynamodb:DescribeTimeToLive`
  - `iam:CreatePolicy`, `iam:GetPolicy`
- The AWS CLI (`aws`) available on `PATH`

## Usage

```bash
swamp extension pull @webframp/dynamodb-datastore-bootstrap

# Create provisioner + shell model instances
swamp model create @webframp/dynamodb-datastore-bootstrap/provisioner \
  swamp-dynamodb-provisioner
swamp model create command/shell swamp-dynamodb-setup

# Run the bootstrap workflow
swamp workflow run @webframp/bootstrap-dynamodb-datastore \
  --input region=us-east-1

# Verify
swamp datastore status
```

## Inputs

| Input         | Default                        | Description                       |
| ------------- | ------------------------------ | --------------------------------- |
| `region`      | `us-east-1`                    | AWS region for the DynamoDB table |
| `table_name`  | `swamp-datastore`              | DynamoDB table name               |
| `policy_name` | `SwampDynamoDBDatastorePolicy` | IAM managed policy name           |

## What gets created

### DynamoDB Table

- **Table name:** configurable (default: `swamp-datastore`)
- **Key schema:** `pk` (String) partition key, `sk` (String) sort key
- **Billing:** PAY_PER_REQUEST (on-demand)
- **TTL:** enabled on `ttl` attribute
- **GSI `gsi1`:** partition key `gsi1pk` (String), sort key `gsi1sk` (String),
  projection ALL — used for prefix-scoped sync walks

### IAM Managed Policy

Grants the minimum permissions required by `@webframp/dynamodb-datastore` at
runtime, scoped to the provisioned table and its indexes:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:BatchWriteItem",
        "dynamodb:DescribeTable"
      ],
      "Resource": [
        "arn:aws:dynamodb:<region>:<account>:table/<table_name>",
        "arn:aws:dynamodb:<region>:<account>:table/<table_name>/index/*"
      ]
    }
  ]
}
```

## Idempotency

The provisioner is fully idempotent:

- If the table already exists with the correct schema, it is reused
- If the IAM policy already exists, its ARN is returned without modification
- TTL enablement is a no-op if already active
- Re-running the workflow safely overwrites the datastore configuration

## Troubleshooting

**`Could not run "aws ..." — the AWS CLI is not installed or not on PATH`**
`awsCli` catches `Deno.errors.NotFound` specifically and rewrites it into
this message; every other command failure is surfaced as the raw `aws`
stderr. If you see this, the AWS CLI itself (not credentials or IAM) is the
problem — install it or fix `PATH` before re-running.

**`Table <name> did not become ACTIVE within 60s`**
`waitForTableActive` polls `describe-table` every 2 seconds for up to 60
seconds after `create-table` returns, then gives up. `PAY_PER_REQUEST` tables
with a GSI normally activate well within that window, but an account near
its DynamoDB table-count service quota, or a transient regional issue, can
push table creation past the timeout — re-running `provision` is safe (the
table-exists check will pick it up once it's actually `ACTIVE`).

**IAM policy creation silently succeeds on a second run despite a raced
create**
`ensurePolicy` checks `iam:GetPolicy` first, but if two provisioner runs race
between that check and `iam:CreatePolicy`, AWS returns
`EntityAlreadyExists` on the loser — the code catches that specifically and
returns the deterministic policy ARN (`arn:aws:iam::<account>:policy/<policy_name>`)
instead of failing, so concurrent bootstrap runs converge rather than error.

**`Could not determine AWS account ID`**
`getAccountId` calls `sts get-caller-identity` to build the IAM policy ARN.
If your AWS credentials are missing, expired, or the wrong profile is active,
this fails before any DynamoDB or IAM resource is touched — check
`aws sts get-caller-identity` directly against the same region/profile the
workflow will use.

## Development

```bash
cd dynamodb-datastore-bootstrap
~/.swamp/deno/deno task check
~/.swamp/deno/deno task test
```
