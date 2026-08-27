## 2026.08.27.1

**Changed:** Test suite now uses the shared `createModelTestContext` factory
from `@systeminit/swamp-testing` instead of a hand-rolled method context. No
behavioral, schema, or method changes — the published model, workflow, and
report behave identically. The `deno.json` gains a dev-only
`@systeminit/swamp-testing` import-map entry.

**Note:** The `lifecycle-metrics` report test keeps its hand-rolled data
repository. The report matches stored artifacts through `entry.tags.specName`, a
field the factory's `TestData` type does not model, so the factory cannot drive
the report's filtering path without fabricating data. This is documented inline
in the test.

## 2026.08.26.3

**Fixed:** Restored inline `npm:zod@4.4.3` import specifiers so the registry
quality scorer can resolve dependencies and score the extension. An earlier
release used a bare `"zod"` import-map specifier, which published but scored as
unscored.

**Changed:** Retained explicit `compilerOptions.strict` in `deno.json`. No
behavioral or schema changes.
