## 2026.08.21.1

**Changed:** Tightened `projectId` and `token` in the datastore config schema to require non-empty strings. Both are required identifiers that the GitLab API would never accept blank, so this only rejects configs that were already broken.

## 2026.08.20.1

**Upgrade note:** Pinned zod to exact version 4.4.3 (was unpinned range `npm:zod@4`). No behavioral changes — dependency version alignment only.
