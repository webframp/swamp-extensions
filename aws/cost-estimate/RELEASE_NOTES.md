## 2026.08.21.2

**Changed:** AWS Pricing API failures in `estimate_ec2`, `estimate_rds`, and
`estimate_from_spec` now raise an error naming the failing `GetProducts` call
and the resource attributes being priced (instance type/DB class, engine,
region, platform, or Multi-AZ setting) instead of surfacing the raw AWS SDK
error with no context.

**Changed:** `estimate_from_spec` now requires at least one of `ec2Instances`
or `rdsInstances` to be provided, and rejects an empty array for either field
instead of silently producing a zero-cost estimate. `count` on `ec2Instances`
must be a positive integer and `storageGb` on `rdsInstances` must be positive.
Instance/DB identifiers, instance types, DB classes, and engine names must be
non-empty strings.

## 2026.08.21.1

**Changed:** Added `.describe()` documentation to the `region`, `platform`, `multiAz`, and `storageGb` fields in `estimate_from_spec`'s `ec2Instances`/`rdsInstances` argument schemas, which previously lacked descriptions while their sibling fields already had them. No behavioral change.
