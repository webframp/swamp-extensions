## 2026.09.18.1

**Fixed:** `attention` and `list_chats` sent `$expand=members,viewpoint` to
Graph's `/me/chats`. `viewpoint` is a per-user computed property, not a
navigation property, so Graph rejected the whole request with `Parsing OData
Select and Expand failed`, and both methods failed outright. `viewpoint` is
now requested via `$select` (alongside every other `GraphChat` field, since
both methods echo raw chat objects into their output resources) while
`$expand` is left to do only what it can: expand `members`.

## 2026.09.15.1

**Changed:** Bump zod 4.4.3 → 4.6.5

## 2026.08.28.1

**Changed:** Normalized the extension license to Apache-2.0 and corrected the
copyright holder to "Sean Escriva". Extensions that previously shipped an MIT
LICENSE.md are now Apache-2.0, consistent with the repository root and every
other extension. No code or behavioral changes.

**Upgrade note:** License text only. No API, schema, or runtime behavior
changed.

## 2026.08.26.2

**Fixed:** Restored inline `npm:zod@4.4.3` import specifiers so the registry
quality scorer can resolve dependencies and score the extension. An earlier
release used a bare `"zod"` import-map specifier, which published but scored as
unscored.

**Changed:** Retained explicit `compilerOptions.strict` in `deno.json`. No
behavioral or schema changes.
