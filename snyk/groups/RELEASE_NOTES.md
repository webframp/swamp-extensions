## 2026.08.21.1

**Changed:** Schema tightening sweep — no behavioral changes.

- Added `.min(1)` to `apiToken`, `groupId`, and the group/organization
  `name` fields (they cannot legitimately be empty).
- Added `.describe(...)` to previously undocumented fields on the group
  policy schemas: `action`, `action_type`, `conditions_group` (and its
  `logical_operator`), `created_at`, `created_by`, `name`, and `updated_at`.
