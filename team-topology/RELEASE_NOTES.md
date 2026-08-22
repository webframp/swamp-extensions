## 2026.08.21.2

**Changed:** `discover_topology` now rejects a call where an interaction's
`source`/`target` or a system dependency's `ownerFrom`/`ownerTo` names a team
that isn't present in that same call's `teams` array. Previously a typo'd or
stale team name was written into the topology snapshot without complaint,
producing a graph edge that pointed at nothing — the error now names the
unknown team(s) and lists the known team names.

**Upgrade note:** No schema changes. If you were passing interactions or
system dependencies that reference teams outside the current call's `teams`
list, include those teams in the call or the write will now fail with a
descriptive error instead of silently succeeding.

## 2026.08.21.1

**Changed:** Added `.describe()` to previously undocumented fields across
the schema — the team-type/interaction-mode/Westrum-culture enums, the
`notes` fields on interactions/flow steps/value streams, the `Finding`
fields (`category`, `severity`, `title`, `description`, `affectedTeams`,
`recommendation`), and the top-level `TopologySchema`/`FlowsSchema`/
`AssessmentSchema` fields. No behavioral change.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `mod.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.
