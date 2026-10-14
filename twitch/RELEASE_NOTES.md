## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.09.18.1

**Fixed:** `helixApiPaginated` now sets `truncated: true` when the post-loop
cap trim actually removes items, instead of returning `truncated: false` for
a result set that is missing data.

**Upgrade note:** Normalized npm:zod reference globally to 4.6.5.
