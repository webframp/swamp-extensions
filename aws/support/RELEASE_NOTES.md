## 2026.07.30.1

**Added:** New extension for AWS Support case management across accounts.

- `list_cases` — List open (or all) support cases for a single account with
  bounded pagination and configurable limit.
- `get_case` — Retrieve full case details including all communications by
  display ID.
- `create_case` — Open a new support case (technical issue type) with subject,
  body, service/category codes, and severity.
- `add_communication` — Add a reply to an existing case by internal case ID.
- `resolve_case` — Close/resolve a case by internal case ID, recording the
  status transition.
- `scan_accounts` — Fan-out across all configured profiles for a fleet-wide
  view of support cases. A single unreachable account does not fail the scan.

Fleet-wide methods redact ARNs, account IDs, URLs, and hostnames from
persisted error messages. SSO login failures collapse to `sso-login-required`.

**Prerequisite:** AWS Business or Enterprise support plan. The Support API is
only available in us-east-1.
