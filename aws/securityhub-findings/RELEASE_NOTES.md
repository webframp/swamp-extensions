## 2026.10.23.1

**Fixed:** `get_severity_summary` paged through findings with no sort order.
Under its five-page (500-finding) cap, a busy organization could truncate the
result to an arbitrary slice, which for a count aggregation undercounts the
severity tallies rather than just dropping rows. It now sorts
`SeverityNormalized` descending like every other query, so a truncated summary
counts the most severe findings first.

**Fixed:** `list_findings` and `list_all_findings` now encode the sort field and
order in their resource instance name. Previously two calls with identical
filters but different sorts hashed to the same resource slot, so a second call
could silently overwrite a prior truncated slice (e.g. replacing the 100 most
severe findings with the 100 oldest) with no signal to any consumer. Sort order
is a correctness property under truncation, so it now participates in instance
identity.

**Added:** `list_findings` and `list_all_findings` accept optional `sortField`
and `sortOrder` arguments. `sortField` is one of `SeverityNormalized`,
`SeverityLabel`, `UpdatedAt`, `CreatedAt`, `FirstObservedAt`, `LastObservedAt`,
`Confidence`, `Criticality`, `ProductName`, `Title`, or `AwsAccountId`;
`sortOrder` is `asc` or `desc`. An invalid value is rejected at the swamp
boundary rather than surfacing as an opaque AWS error. The override is
deliberately absent from `get_severity_summary`, `list_findings_by_type`, and
`diff_findings`: those consume the truncated set (diff refuses to diff when
truncated), so their severity-descending order is a correctness guarantee, not
a preference.

**Changed:** Every `GetFindings` query now sorts by severity descending by
default.

**Upgrade note:** Backward compatible. The new arguments are optional and
default to the prior severity-descending behavior; existing instances and
callers are unaffected and need no changes.

## 2026.10.21.1

**Changed:** Documentation only: the README no longer lists environment
variables or a static shared-credentials file as a way to supply AWS
credentials. It now recommends AWS SSO or a named profile
(`aws sso login --profile <name>`, then `--global-arg profile=<name>`), or an
IAM role attached to where swamp runs. Credential resolution is unchanged: the
model still uses the AWS SDK default credential chain when `profile` is unset.

**Upgrade note:** No code, schema, or behavioral changes. The model version
moves to 2026.10.21.1 with an identity upgrade.
