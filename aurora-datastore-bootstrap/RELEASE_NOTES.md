## 2026.08.27.1

**Changed:** Test suite now builds its method context from the shared
`createModelTestContext` factory in `@systeminit/swamp-testing` instead of a
hand-rolled context, wrapping `writeResource` to preserve the existing assertion
API. No behavioral, schema, or method changes — the published provisioner is
unchanged. The `deno.json` gains a dev-only `@systeminit/swamp-testing`
import-map entry and its `check` task now type-checks the test file.

## 2026.08.26.3

**Fixed:** Restored inline `npm:zod@4.4.3` import specifiers so the registry
quality scorer can resolve dependencies and score the extension. An earlier
release used a bare `"zod"` import-map specifier, which published but scored as
unscored.

**Changed:** Retained explicit `compilerOptions.strict` in `deno.json`. No
behavioral or schema changes.
