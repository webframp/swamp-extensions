## 2026.08.21.1

**Changed:** Schema tightening sweep — no behavioral changes.

- Added `.min(1)` to `apiToken` and `groupId` in the global arguments schema.
- Added `.describe(...)` to the previously undocumented fields in the
  `asset_projects` resource schema (`name`, `organization_id`,
  `organization_name`, `project_type`, `target_file`, `target_id`,
  `target_reference`, `test_surface`, `url`, `last_scan`, and the
  `issues_counts` breakdown).
