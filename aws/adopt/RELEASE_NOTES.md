## 2026.08.21.1

**Changed:** Every AWS SDK call (EC2, RDS, Secrets Manager, CloudFormation)
used to propagate its raw SDK exception with no indication of which
operation was running or what it was scoped to. Failures now name the
operation (e.g. `DescribeVpcs`, `ListStackResources`) and, where relevant,
the region, VPC ID, or stack name, while preserving the original error
message — a discovery failure now says what was being attempted instead of
surfacing a bare SDK error.

`region` and `vpcId` global arguments are now validated at model-creation
time (region must match AWS region shape, `vpcId` must match `vpc-[a-f0-9]+`)
instead of accepting any string and failing deep inside the first API call.
