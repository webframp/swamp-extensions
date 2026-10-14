## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.09.19.1

**Fixed:** `redmineApi`/`redmineApiPaginated` had no retry logic — any 429
(or 502/503/504) failed the request outright. A caller sequentially fetching
many issues (e.g. an enrichment step iterating over a large ticket list) can
trip Redmine's rate limiter even at concurrency 1, and every prior release
turned that into a hard failure. Both helpers now retry through a shared
`fetchWithRetry`, honoring `Retry-After` when the server sends one and
falling back to exponential backoff (up to 4 retries) otherwise.

## 2026.09.18.1

**Upgrade note:** Normalized `npm:zod` dependency version to 4.6.5 across the
repo. No behavioral changes in this extension.
