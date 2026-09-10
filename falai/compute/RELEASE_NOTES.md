## 2026.09.10.1

**Fixed:**

- `create_*` methods for endpoints whose response wraps the created resource's
  id one level deep (e.g. `{ collection: { id } }`, `{ asset: { asset_id } }`)
  or addresses it by name instead of id (`{ workflow: { name } }`) now resolve
  the correct field instead of falling through to a fixed `"created"` instance
  slot and silently overwriting every prior call.
- `create_*` methods whose response carries no id- or name-shaped field at all
  (e.g. `{ success: true }`, `{ signed_url: "..." }`) now derive a
  deterministic, collision-resistant instance name from the request instead of
  colliding on `"created"`.
- fal.ai API token resolution used `||`, so an empty-string vault result
  silently fell through to the `FAL_KEY` environment variable — routing calls to
  the wrong account with no error. Now uses `??`, so an explicit empty token is
  treated as set and fails with a clear error instead.
- Cursor-paginated fetches that returned a full page with no `next_cursor` to
  continue with now correctly report `truncated: true` instead of silently
  stopping and claiming completeness.
- `get_app_queue_info` (and other multi-path-param get/update methods) used only
  the last path parameter for the resource instance name, colliding two
  different owners' same-named resources. All path parameters are now joined
  into the instance name.

**Upgrade note:** No schema changes. All fixes are internal to method execution;
existing stored resources are unaffected.
