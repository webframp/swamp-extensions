## 2026.08.21.2

**Changed:** `policy_id` now must be a non-empty string — previously an empty
value passed schema validation and only failed deep inside the Snyk API call
with a generic 404. Errors from the Snyk API now name the HTTP method and path
that was attempted instead of just the bare status and body. Network-level
failures (DNS, connection refused, TLS errors) reaching the Snyk API are now
also caught and reported with the operation and path that was being attempted,
rather than surfacing as an unhandled `fetch` exception.

## 2026.08.21.1

**Changed:** Schema tightening sweep — no behavioral changes.

- Added `.min(1)` to `apiToken` and `orgId` in the global arguments schema.
- Added `.describe(...)` to previously undocumented fields on the org policy
  schemas: `action`, `action_type`, `conditions_group`, `created_at`,
  `created_by`, `name`, and `updated_at`; and on the policy event schema:
  `type`, `changes`, `comment`, `created_at`, and `created_by`.
