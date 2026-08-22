## 2026.08.21.1

**Changed:** GuardDuty API failures now name the operation and detector/finding
IDs involved instead of surfacing the raw SDK error. `ListDetectors`,
`ListFindings`, `GetFindings` (in both `list_findings` and
`get_finding_details`), and `ListMembers` failures all raise a clear error
identifying what was being fetched and for which detector, with the original
SDK error preserved as the cause.

`list_findings`'s `severityMin` argument now enforces the documented 0-10
range at the schema level instead of silently accepting out-of-range values
that GuardDuty would reject deep inside the API call.

No schema changes.
