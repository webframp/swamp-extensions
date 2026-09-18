## 2026.09.18.1

**Fixed:** `helixApiPaginated` now sets `truncated: true` when the post-loop
cap trim actually removes items, instead of returning `truncated: false` for
a result set that is missing data.

**Upgrade note:** Normalized npm:zod reference globally to 4.6.5.
