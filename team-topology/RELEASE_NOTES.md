## 2026.08.21.1

**Changed:** Added `.describe()` to previously undocumented fields across
the schema — the team-type/interaction-mode/Westrum-culture enums, the
`notes` fields on interactions/flow steps/value streams, the `Finding`
fields (`category`, `severity`, `title`, `description`, `affectedTeams`,
`recommendation`), and the top-level `TopologySchema`/`FlowsSchema`/
`AssessmentSchema` fields. No behavioral change.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `mod.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.
