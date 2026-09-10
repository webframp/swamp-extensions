## 2026.09.10.2

**Fixed:**

- Query-parameter loops for GET requests treated `null` as a value to send,
  producing e.g. `?media_type=null` for any nullable filter explicitly cleared
  by the caller. `null` is now skipped alongside `undefined`, matching the "omit
  this parameter" semantics both values are meant to carry.
- Paginated `list_*` methods silently ignored the caller's `limit`/`cursor`
  arguments and always fetched up to 2000 items regardless of what was
  requested. `falApiPaginated` now accepts the caller's `limit`/`cursor` and
  stops once the requested count is reached, slicing to exactly that many and
  reporting `truncated: true` when more data may exist beyond it.
- Path parameters (asset IDs, collection IDs, key IDs, etc.) are now URL-encoded
  before being interpolated into request paths, so a value containing `/` or
  `..` can no longer change which path segment is requested.

**Upgrade note:** No schema changes. All fixes are internal to method execution;
existing stored resources are unaffected.
