## 2026.08.21.1

**Changed:** Added `.describe()` documentation to every previously undocumented field in the
resource schemas (`SharingSchema`, `VmSchema`, `FleetSchema`, `StatSchema`, `ExecResultSchema`,
`ShelleyVersionSchema`, `ShelleyVersionsSchema`, `ShelleyUpgradeResultSchema`, and the inline
`shelleyUpgrade` resource schema). No behavioral change — method argument schemas were already
fully documented and are untouched.

## 2026.08.04.1

**Added:** Initial release of the exe.dev VM lifecycle model. Methods: setup,
sync, create, destroy, restart, resize, stat, tag, exec, comment, share,
shelley_versions, shelley_upgrade. Full fleet observation with typed resources,
pre-flight existence checks on destructive operations, and actionable 403
diagnostics guiding token permission fixes.
