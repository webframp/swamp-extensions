## 2026.08.21.2

**Changed:**

- Errors raised when a Cloudflare API call fails now name the HTTP method
  and path that was attempted (e.g. `Cloudflare API GET
  /accounts/.../dns_protection/rules failed with HTTP 400 ...`) instead of
  a bare `Cloudflare API error: ...`. Network-level failures (DNS,
  connection reset, timeout) are now also caught and wrapped with the same
  operation context instead of surfacing a raw `fetch` error.
- `listdnsprotectionrulesforaccount` (and its sibling account/zone
  DNS-protection listing methods) now enforce the documented `per_page`
  bounds of 10-1000 at the schema level, instead of letting an out-of-range
  value fail deep inside the Cloudflare API call.

No breaking changes. Existing calls that already respected the documented
`per_page` range are unaffected.
