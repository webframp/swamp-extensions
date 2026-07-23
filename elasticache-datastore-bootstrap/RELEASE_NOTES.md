## 2026.07.23.1

**Added:** Initial release of `@webframp/elasticache-datastore-bootstrap` —
one-shot provisioner for AWS ElastiCache Serverless (Valkey engine) targeting
`@webframp/valkey-datastore`.

Creates an ElastiCache Serverless cache with TLS, a VPC security group (TCP/6379
from VPC CIDR), and a least-privilege IAM managed policy, then configures the
swamp repo datastore via a two-job workflow.

**Fixed:**

- Subnet IDs from user input are validated per-element against
  `/^subnet-[a-f0-9]+$/` after split, preventing CLI argument injection
- `key_prefix` constrained to max 64 chars and safe characters only
  (`[a-zA-Z0-9_\-:.]`) — prevents shell injection via workflow template
- `--policy-document` values are redacted from AWS CLI error messages to avoid
  leaking ARNs and account IDs in logs
- `waitForCacheAvailable` throws immediately when cache returns null (deleted
  mid-wait) or enters `deleting`/`deleted` terminal state
- `getDefaultVpcId` throws if multiple default VPCs found, requiring explicit
  `vpc_id`
- Idempotency path waits for cache availability when re-running against a cache
  in `creating` state, preventing broken endpoint URLs
- `describeServerlessCache` only swallows `ServerlessCacheNotFoundFault` — other
  errors propagate correctly
- `ensureSecurityGroup` verifies port 6379/tcp ingress on reused security groups
  and adds it if missing
- `getSubnetIds` validates filtered subnet IDs are non-empty
- `security_group_name` schema rejects commas to prevent tag argument injection
- Empty cache ARN or endpoint address throws immediately instead of producing
  malformed output
