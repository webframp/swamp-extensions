## 2026.08.28.2

**Fixed:** The sweep no longer corrupts model upgrade chains. Previously
`plan-bump` emitted a `toVersion: "<old>" → "<new>"` find/replace that
relabelled the last existing upgrade entry in place, destroying the prior
version's migration step and attaching its description to the wrong version. It
passed the shallow chain check only because the last `toVersion` still equalled
the model version. `apply-bump` now APPENDS a new no-op upgrade entry (identity
`upgradeAttributes`) to every model `upgrades:` array instead, leaving prior
entries intact.

**Fixed:** The sweep now updates exact-literal test version assertions. Tests of
the form `assertEquals(model.version, "<old>")` were left pointing at the old
version, breaking `deno test` after a bump (as happened to the 5
`*-datastore-bootstrap` extensions in the license sweep). `plan-bump` now emits
a `test-assertion` change for each distinct asserted literal. Pattern-based
assertions (`assertMatch(model.version, /regex/)`) carry no literal and are
untouched.

**Added:** `checkUpgradeChain` now detects the relabel anti-pattern. When given
the version a bump came from, it errors if that previous shipped version's chain
entry is missing — catching an in-place relabel even though the last `toVersion`
matches the model version.

**Added:** `BumpPlanEntry.upgradeInserts` (structured append instructions) and a
`test-assertion` change category.

**Upgrade note:** Behavior of the maintenance sweep only. This tool must never
be used for a schema-changing bump — the appended migration is identity and
would silently fail to migrate stored data. Dependency and license bumps (its
only purpose) never change data shape.

## 2026.08.28.1

**Changed:** Normalized the extension license to Apache-2.0 and corrected the
copyright holder to "Sean Escriva". Extensions that previously shipped an MIT
LICENSE.md are now Apache-2.0, consistent with the repository root and every
other extension. No code or behavioral changes.

**Upgrade note:** License text only. No API, schema, or runtime behavior
changed.

## 2026.08.26.3

**Fixed:** Restored inline `npm:zod@4.4.3` import specifiers so the registry
quality scorer can resolve dependencies and score the extension. An earlier
release used a bare `"zod"` import-map specifier, which published but scored as
unscored.

**Changed:** Retained explicit `compilerOptions.strict` in `deno.json`. No
behavioral or schema changes.
