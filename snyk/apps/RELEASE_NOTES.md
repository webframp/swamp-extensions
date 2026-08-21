## 2026.08.21.1

**Changed:** Schema tightening sweep — no behavioral changes.

- Added `.min(1)` to `apiToken`, `orgId`, and the `client_id`/`client_secret`
  pair on `create_group_app_install`/`create_org_app_install` resource
  schemas, matching the same fields elsewhere in this model that already
  required a non-empty string.
- Added `.describe(...)` to the previously undocumented `org_public_id` field
  (five occurrences) and the `secret` field used in app-secret rotation
  payloads.
