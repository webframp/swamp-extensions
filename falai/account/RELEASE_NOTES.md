## 2026.09.10.3

**Fixed:**

- `create_*` methods now only trust an id/name field discovered in the response
  schema when that field is both required and non-nullable. `upload_asset`'s
  `asset.asset_id` is documented as nullable while an upload is still
  processing; treating it as a stable id meant every such response collided onto
  the fixed "created" instance slot. Affected create methods now correctly fall
  back to a deterministic hash of the request (or pick a sibling
  required/non-nullable id field, e.g. `vector_id`, when one exists) instead of
  colliding.

**Upgrade note:** No schema changes. All fixes are internal to method execution;
existing stored resources are unaffected.
