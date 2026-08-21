## 2026.08.21.1

**Changed:** Schema tightening sweep — no behavioral changes.

- Added `.min(1)` to `apiToken` and `orgId` in the global arguments schema.
- Added `.describe(...)` to previously undocumented fields: `layers`, `names`,
  and `platform` on the container image schema; `platform`, `target_id`, and
  `target_reference` on the image target reference schema.
