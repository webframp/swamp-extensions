## 2026.09.18.1

**Fixed:** `redmineApi`/`redmineApiPaginated` had no retry logic — any 429
(or 502/503/504) failed the request outright. A caller sequentially fetching
many issues (e.g. an enrichment step iterating over a large ticket list) can
trip Redmine's rate limiter even at concurrency 1, and every prior release
turned that into a hard failure. Both helpers now retry through a shared
`fetchWithRetry`, honoring `Retry-After` when the server sends one and
falling back to exponential backoff (up to 4 retries) otherwise.

## 2026.09.15.1

**Changed:** Bump zod 4.4.3 → 4.6.5

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
