## 2026.07.23.1

**Added:** Initial release of `@webframp/elasticache-datastore-bootstrap` —
one-shot provisioner for AWS ElastiCache Serverless (Valkey engine) targeting
`@webframp/valkey-datastore`.

Creates an ElastiCache Serverless cache with TLS, a VPC security group (TCP/6379
from VPC CIDR), and a least-privilege IAM managed policy, then configures the
swamp repo datastore via a two-job workflow.

**Fixed:**

- Idempotency path now waits for cache availability when re-running against a
  cache in `creating` state, preventing broken endpoint URLs
- `describeServerlessCache` only swallows `ServerlessCacheNotFoundFault` — other
  errors (permissions, endpoint resolution) propagate correctly
- `ensureSecurityGroup` verifies port 6379/tcp ingress exists on reused security
  groups and adds it if missing, fixing partial-creation scenarios
- `getSubnetIds` validates that filtered subnet IDs are non-empty
- `security_group_name` schema rejects commas to prevent tag argument injection
- `waitForCacheAvailable` exits immediately on terminal states (`deleting`,
  `deleted`) instead of burning the full 10-minute timeout
- Empty cache ARN or endpoint address throws immediately instead of producing
  malformed IAM policy or datastore config
