## 2026.08.21.2

**Changed:** GitLab API failures now name the operation and the state they were acting on. Errors from `getState`, `putState`, `deleteState`, `lock`, and `unlock` used to report only an HTTP status (e.g. "GitLab API error: 500 Internal Server Error"); they now say which state and which operation failed. `listStates` previously swallowed project-lookup and GraphQL failures by silently returning an empty list — a transient 500 during push looked identical to "no remote states," which could cause `pushChanged` to tombstone (delete) every locally-tracked file as if it no longer existed remotely. It now throws instead, so a listing failure surfaces as an error rather than as data loss. `getLockInfo` likewise used to treat any non-2xx/404/204 response as "not locked"; it now throws on unexpected failures rather than letting `acquire()` or `forceRelease()` proceed as though a lock were free when the server call actually failed.

## 2026.08.21.1

**Changed:** Tightened `projectId` and `token` in the datastore config schema to require non-empty strings. Both are required identifiers that the GitLab API would never accept blank, so this only rejects configs that were already broken.

## 2026.08.20.1

**Upgrade note:** Pinned zod to exact version 4.4.3 (was unpinned range `npm:zod@4`). No behavioral changes — dependency version alignment only.
