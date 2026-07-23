## 2026.07.23.1

**Added:** Initial release of `@webframp/elasticache-datastore-bootstrap` —
one-shot provisioner for AWS ElastiCache Serverless (Valkey engine) targeting
`@webframp/valkey-datastore`.

Creates an ElastiCache Serverless cache with TLS, a VPC security group (TCP/6379
from VPC CIDR), and a least-privilege IAM managed policy, then configures the
swamp repo datastore via a two-job workflow.

**Fixed:** Idempotency path now waits for cache availability when re-running
against a cache that is still in `creating` state, preventing broken endpoint
URLs from being committed to the resource store.
