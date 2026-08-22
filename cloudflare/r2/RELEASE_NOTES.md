## 2026.08.21.3

**Changed:**

- Errors raised when a Cloudflare API call fails now name the HTTP method
  and path that was attempted (e.g. `Cloudflare API GET
  /accounts/.../r2-catalog/xxx/namespaces/yyy/tables failed with HTTP
  400 ...`) instead of a bare `Cloudflare API error: ...`. Network-level
  failures (DNS, connection reset, timeout) are now also caught and wrapped
  with the same operation context instead of surfacing a raw `fetch`
  error.
- `disable_catalog`, `enable_catalog`, `list_tables`, `get_table`,
  `get_table_maintenance_config`, and `update_table_maintenance_config`
  now reject an empty `bucket_name`, `namespace`, or `table_name` before
  making a request. Previously these identifiers were validated on some
  R2 catalog methods but not others, so an empty value on the unvalidated
  ones would fail deep inside the Cloudflare API call with a less specific
  error.
- `list_namespaces` and `list_tables` now enforce the documented `page_size`
  bounds (1 to 1000) at the schema level, instead of letting an
  out-of-range value fail inside the Cloudflare API call.

No breaking changes. Existing calls that already supplied non-empty
identifiers and in-range page sizes are unaffected.
