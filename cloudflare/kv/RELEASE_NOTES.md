## 2026.08.21.3

**Changed:**

- Errors raised when a Cloudflare API call fails now name the HTTP method
  and path that was attempted (e.g. `Cloudflare API PUT
  /accounts/.../storage/kv/namespaces/xxx/bulk failed with HTTP 400 ...`)
  instead of a bare `Cloudflare API error: ...`. Network-level failures
  (DNS, connection reset, timeout) are now also caught and wrapped with the
  same operation context instead of surfacing a raw `fetch` error.
- `delete_multiple_key_value_pairs` and `update_workers_kv_namespace_write_multiple_key_value_pairs`
  now reject an empty `items` array before making a request, instead of
  sending a no-op request to Cloudflare.
- `delete_multiple_key_value_pairs` now enforces the documented 10,000-key
  limit and `get_multiple_key_value_pairs` now enforces the documented
  100-key limit at the schema level, so an oversized batch fails immediately
  with a clear message instead of failing deep inside the Cloudflare API
  call.

No breaking changes. Existing calls that already respected these limits are
unaffected.
