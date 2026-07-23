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

## Development

```bash
cd dynamodb-datastore-bootstrap
~/.swamp/deno/deno task check
~/.swamp/deno/deno task test
```
