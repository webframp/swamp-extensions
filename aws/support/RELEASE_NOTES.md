## 2026.08.21.1

**Changed:** Tightened `displayId`, `serviceCode`, `categoryCode`, and `caseId`
arguments across `get_case`, `create_case`, `add_communication`, and
`resolve_case` to require non-empty strings — these are required identifiers
the Support API already rejects when empty.

## 2026.08.20.1

**Changed:** Bump @aws-sdk/* 3.1111.0 → 3.1114.0 (3 packages)

## 2026.08.15.1

**Changed:** Bump @aws-sdk/* 3.1104.0 → 3.1111.0 (3 packages)

## 2026.08.05.1

**Changed:** Bump @aws-sdk/* 3.1101.0 → 3.1104.0 (3 packages)

## 2026.08.02.1

**Changed:** Bump @aws-sdk/* 3.1096.0 → 3.1101.0 (3 packages)

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
