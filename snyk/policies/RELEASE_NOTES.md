## 2026.08.21.1

**Changed:** Schema tightening sweep — no behavioral changes.

- Added `.min(1)` to `apiToken` and `orgId` in the global arguments schema.
- Added `.describe(...)` to previously undocumented fields on the org policy
  schemas: `action`, `action_type`, `conditions_group`, `created_at`,
  `created_by`, `name`, and `updated_at`; and on the policy event schema:
  `type`, `changes`, `comment`, `created_at`, and `created_by`.
