## 2026.07.22.1

**Added:** One-shot bootstrap for `@webframp/dynamodb-datastore`. Ships a
provisioner model that creates a DynamoDB table (PAY_PER_REQUEST, GSI `gsi1`,
TTL on `ttl`) and a scoped IAM managed policy (7 actions), plus a workflow that
runs the provisioner and switches the repo datastore to DynamoDB.

**Added:** Full idempotency — re-running the provisioner against existing
infrastructure is a no-op that reports `tableCreated: false` and
`policyCreated: false`.

**Added:** TOCTOU-safe policy creation — concurrent provisioner runs will not
fail if the policy is created between the existence check and the create call.
