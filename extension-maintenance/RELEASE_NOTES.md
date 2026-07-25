## 2026.07.25.2

**Fixed:** Scoped extension names (`@webframp/...`) in manifest dependency pins
are now parsed correctly. Previous regex silently failed on the leading `@`,
causing all manifest deps to be reported as up-to-date.

**Fixed:** `nextCalVer()` increments the sequence number when an extension was
already bumped today, preventing no-op replacements or version field corruption
on same-day re-runs.

**Fixed:** `registry_timeout` global argument is now applied to all fetch calls
via `AbortSignal.timeout()`. Previously validated but never used.

**Fixed:** Test-only stale entries (swamp-testing bump) no longer emit plan
entries or overwrite existing RELEASE_NOTES.md with empty content.

**Fixed:** Manifest version replacement uses the full `version: "X.Y.Z.N"` field
string instead of the bare version, preventing accidental substitution in
manifest description blocks.

**Changed:** Unversioned npm imports (e.g. `npm:zod` without a pinned version)
are now logged as warnings during audit instead of being silently skipped.

**Changed:** `apply-bump` dry-run mode now reads files and counts matches,
producing accurate `filesModified` counts that match what a real run would do.
