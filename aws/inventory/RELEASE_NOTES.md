## 2026.08.21.1

**Changed:** Inventory failures now say which service and region were being
scanned instead of surfacing the raw SDK error. `list_ec2`, `list_rds`,
`list_dynamodb`, `list_lambda`, `list_s3`, `list_ebs`, and `inventory_all`
each wrap failures from their underlying AWS API calls with the resource
type and region (or "S3 buckets" for the global method), preserving the
original SDK error as the cause. The Resource Groups Tagging API fallback
used by `inventory_scan`/`inventory_diff` now also names the region in its
error message.

No schema changes.
