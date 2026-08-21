## 2026.08.21.1

**Changed:** Schema tightening sweep — no behavioral changes.

- Added `.min(1)` to `apiToken` and `orgId` in the global arguments schema.
- Added `.describe(...)` to previously undocumented fields on the asset
  projects schemas (group and org scope): the `base_image_remediation`
  sub-fields (`base_image`, `base_image_name`, `base_image_outdated`,
  `code`, `distro_alert`, `proposed_base_images`) and the `issues`
  severity-count breakdown.
