## 2026.08.21.2

**Changed:** exe.dev API request failures (network errors, DNS failures, connection
resets) now raise an error that names the exe.dev command that was being attempted,
instead of surfacing the raw fetch error with no context. The timeout error message
also now includes the command that timed out. A malformed/non-JSON response from
the exe.dev API now raises a clear "returned malformed JSON for command ..." error
(including a snippet of the raw response) instead of a bare `JSON.parse` SyntaxError.

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
