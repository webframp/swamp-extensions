## 2026.08.29.1

**Changed:** Bump @aws-sdk/* 3.1120.0 → 3.1121.0. Dependency-only update; no schema, API, or behavioral changes.

## 2026.08.28.2

**Changed:** Normalized the extension license to Apache-2.0 and corrected the
copyright holder to "Sean Escriva". Extensions that previously shipped an MIT
LICENSE.md are now Apache-2.0, consistent with the repository root and every
other extension. No code or behavioral changes.

**Upgrade note:** License text only. No API, schema, or runtime behavior
changed.

## 2026.08.28.1

**Changed:** Bump @aws-sdk/* 3.1114.0 → 3.1120.0 (2 packages)

**Fixed:** Removed dead, unused `@aws-sdk/client-dynamodb` and
`@aws-sdk/lib-dynamodb` entries from the `deno.json` import map. All source
imports already use inline `npm:` specifiers, so the map entries were
unreferenced; they were pinned at a stale 3.1091.0 and pulled a ghost version
into `deno.lock`. No behavioral change.

## 2026.08.26.3

**Fixed:** Restored inline `npm:zod@4.4.3` import specifiers so the registry
quality scorer can resolve dependencies and score the extension. An earlier
release used a bare `"zod"` import-map specifier, which published but scored as
unscored.

**Changed:** Retained explicit `compilerOptions.strict` in `deno.json`. No
behavioral or schema changes.
