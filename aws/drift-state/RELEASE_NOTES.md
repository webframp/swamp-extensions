## 2026.09.04.1

**Changed:** Bump @webframp/aws/adopt 2026.08.28.1 → 2026.08.29.1

**Changed:** Bump @webframp/aws/inventory 2026.08.28.1 → 2026.08.29.1

## 2026.08.28.3

**Changed:** Normalized the extension license to Apache-2.0 and corrected the
copyright holder to "Sean Escriva". Extensions that previously shipped an MIT
LICENSE.md are now Apache-2.0, consistent with the repository root and every
other extension. No code or behavioral changes.

**Upgrade note:** License text only. No API, schema, or runtime behavior
changed.

## 2026.08.28.2

**Fixed:** Re-pinned `@webframp/aws/adopt` and `@webframp/aws/inventory` to
2026.08.28.1 — the versions published in the prior sweep. The 2026.08.28.1
release of this composite still pinned the pre-sweep 2026.08.26.3 leaf versions
(SDK 3.1114.0), so its dependency graph did not deliver the AWS SDK 3.1120.0
bump it was bumped alongside. No schema or behavioral changes.

## 2026.08.28.1

**Changed:** Bump @webframp/aws/adopt 2026.08.20.1 → 2026.08.26.3

**Changed:** Bump @webframp/aws/inventory 2026.08.20.1 → 2026.08.26.3

## 2026.08.26.2

**Fixed:** Restored inline `npm:zod@4.4.3` import specifiers so the registry
quality scorer can resolve dependencies and score the extension. An earlier
release used a bare `"zod"` import-map specifier, which published but scored as
unscored.

**Changed:** Retained explicit `compilerOptions.strict` in `deno.json`. No
behavioral or schema changes.
