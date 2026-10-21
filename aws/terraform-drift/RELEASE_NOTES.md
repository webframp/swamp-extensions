## 2026.10.21.1

**Fixed:** Terraform attributes masked as `***SENSITIVE***` by
`@webframp/terraform` `read_state` produced false drift. A wholly sensitive tag
map (for example `merge()` over a sensitive variable) arrives as the mask
string, and the report either listed one fake `tags.<n>` drift per character or
failed with a `TypeError`. A masked scalar (`instance_type`, `subnet_id`,
`name`, `public_ip`, `internal`) was reported as changed, and a masked `id`,
`arn` or `allocation_id` was reported as `missing_in_aws`.

**Changed:** Masked values are now treated as unverifiable rather than drift.
The JSON output adds an `unverifiable` array (`tfAddress`, `tfType`,
`resourceId`, `field`) and a `summary.unverifiableFields` count, and the
Markdown report adds an "Unverifiable Fields" section when any exist. A resource
with a masked identifier is skipped rather than flagged missing. When `tags_all`
is masked the report no longer falls back to `tags`, which omits provider
`default_tags`.

**Upgrade note:** Additive output change; existing `summary` and `findings`
fields are unchanged. Works with any `@webframp/terraform` version; the masking
it handles arrives with `@webframp/terraform` 2026.10.21.1.
