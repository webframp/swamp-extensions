## 2026.08.21.1

**Changed:** Schema tightening sweep — no behavioral changes.

- Added `.min(1)` to `apiToken` and `orgId` in the global arguments schema.
- Added `.describe(...)` to previously undocumented fields: `deleted_at`
  (environments, resources, and scans), `options`/`properties` on the
  environment schemas, and `type`/`data` on the permissions schema.
