## 2026.08.28.2

**Changed:** Normalized the extension license to Apache-2.0 and corrected the
copyright holder to "Sean Escriva". Extensions that previously shipped an MIT
LICENSE.md are now Apache-2.0, consistent with the repository root and every
other extension. No code or behavioral changes.

**Upgrade note:** License text only. No API, schema, or runtime behavior
changed.

## 2026.08.28.1

**Changed:** Test suite is now fully hermetic — the lock, sync, and verifier
tests run against an in-memory fake and no longer require a live Valkey server
or a CI service container. The extension rejoins the standard CI test matrix.

**Added:** `createValkeyLock`, `createSyncService`, and `createValkeyVerifier`
are now exported from the module. They were already the internal building
blocks of `createProvider`; exporting them lets callers (and tests) inject a
client. Behavior of the datastore provider is unchanged.

## 2026.08.26.3

**Fixed:** Restored inline `npm:zod@4.4.3` import specifiers so the registry
quality scorer can resolve dependencies and score the extension. An earlier
release used a bare `"zod"` import-map specifier, which published but scored as
unscored.

**Changed:** Retained explicit `compilerOptions.strict` in `deno.json`. No
behavioral or schema changes.
