## 2026.08.28.2

**Fixed:** Re-pinned `@webframp/agentcore` to 2026.08.28.1 — the version
published in the prior sweep. The 2026.08.28.1 release of this composite still
pinned the pre-sweep 2026.08.26.3, so its dependency graph did not deliver the
AWS SDK 3.1120.0 bump. `@webframp/container-image` was not part of the sweep and
remains at 2026.08.26.2. No schema or behavioral changes.

## 2026.08.28.1

**Changed:** Bump @webframp/container-image 2026.08.01.1 → 2026.08.26.2

**Changed:** Bump @webframp/agentcore 2026.08.20.1 → 2026.08.26.3

## 2026.08.27.1

**Changed:** Test suite now uses the shared `createModelTestContext` factory
from `@systeminit/swamp-testing` for the method context, replacing a hand-rolled
context. The factory context is augmented with an `extensionFile` stub the
factory does not model, and the local `spawn()`-aware `withMockedCommand` is
retained. No behavioral, schema, or method changes — the published provisioner
is unchanged. The `deno.json` gains a dev-only `@systeminit/swamp-testing`
import-map entry and its `check` task now type-checks the test file.

## 2026.08.26.3

**Fixed:** Restored inline `npm:zod@4.4.3` import specifiers so the registry
quality scorer can resolve dependencies and score the extension. An earlier
release used a bare `"zod"` import-map specifier, which published but scored as
unscored.

**Changed:** Retained explicit `compilerOptions.strict` in `deno.json`. No
behavioral or schema changes.
