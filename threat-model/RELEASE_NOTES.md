## 2026.08.21.1

**Changed:** Added `.describe()` to previously undocumented fields on the
`AssetSchema`, `ThreatScenarioSchema`, `ControlSchema`, `AcceptanceSchema`,
`AssessmentSchema`, and `PostureSchema` resource schemas (e.g. `title`,
`description`, `effectiveness`, `acceptedBy`, `byStatus`, `byRiskLevel`,
`unmitigatedAboveThreshold`). No behavioral change.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `mod.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.
