## 2026.09.09.2

**Fixed:**

- `create_api_key` no longer persists the one-time `key_secret`/`key` credential
  fields to the datastore; they are stripped before the resource is written.
- `create_*` methods derived their stored instance name from a hardcoded `.id`
  field even when the API's actual response used a different id field (e.g.
  `key_id`), silently overwriting prior instances under the same fallback slot.
  The instance name is now derived from the operation's documented response
  schema.
- Fixed a `TypeError: Body already consumed` crash when a request exhausted all
  429 retries — the response body is now read exactly once and cached for every
  caller.
- Array-valued filter arguments (e.g. `media_type`, `endpoint_id`, `tag_id`)
  were serialized as a single comma-joined query parameter instead of repeated
  `key=value` pairs, causing the API to receive a malformed filter. Arrays are
  now appended as repeated parameters.
- List methods that accept a caller-supplied `limit` without pagination cursors
  hardcoded `truncated: false` even when a full page was returned. `truncated`
  is now set when the returned page is exactly `limit` long.
- Cursor-paginated fetches that received `has_more: true` with no `next_cursor`
  now correctly report `truncated: true` instead of silently stopping.

**Upgrade note:** No schema changes. All fixes are internal to method execution;
existing stored resources are unaffected.
