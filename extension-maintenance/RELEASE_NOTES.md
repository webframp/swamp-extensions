## 2026.07.26.2

**Added:** Three new observations in the `audit` method:

1. **Lockfile-sync validation.** For each extension with both a `deno.json` and a
   `deno.lock`, the audit now checks whether the lock resolves every pin in
   `deno.json`. If not, the extension is flagged as `lockDrifted: true`, with
   the specific stale entries listed. This catches the exact state that caused
   the lockfile-consistency cleanup in #278: a `deno.json` pin changes, nobody
   runs `deno install`, and the lock silently drifts.

2. **Direct-specifier detection.** Finds `.ts` source files that import a
   versioned `jsr:` or `npm:` specifier directly instead of using the
   `deno.json` import map alias. These bypass any pin change made to
   `deno.json`, which is how `datastore/azure-blob` and `datastore/dynamodb`
   kept re-introducing the old `swamp-testing` version in their locks even after
   the pin was updated.

3. **Audit summary categories** now include `lockDrifted` (extensions with
   deno.lock out of sync) and `directSpecifiers` (extensions with imports
   bypassing the import map).

**Changed:** `plan-bump` now reports a `skipped` array alongside `entries`. Each
entry names the extension, its directory, and the reason it was excluded. Before
this, "stale but test-only, correctly skipped" was indistinguishable from
"nothing stale" in the plan output.

**Changed:** `apply-bump` now runs `deno install` in each affected extension
directory after writing pin changes. Without this, `apply-bump` creates the exact
lockfile-drift state that the new audit check is designed to catch.

**Upgrade note:** The `audit` resource schema has new required fields
(`lockfileSync`, `directSpecifiers`, `lockDrifted` per extension, and
`lockDrifted`/`directSpecifiers` in the categories object). The `plan` resource
schema now requires a `skipped` array. CEL queries against older audit or plan
data will need to account for missing fields.
