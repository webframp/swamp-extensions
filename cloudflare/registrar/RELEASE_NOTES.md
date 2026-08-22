## 2026.08.21.2

**Changed:**

- Errors raised when a Cloudflare API call fails now name the HTTP method
  and path that was attempted (e.g. `Cloudflare API POST
  /accounts/.../registrar/domains/discovery failed with HTTP 400 ...`)
  instead of a bare `Cloudflare API error: ...`. Network-level failures
  (DNS, connection reset, timeout) are now also caught and wrapped with
  the same operation context instead of surfacing a raw `fetch` error.
- `create_registrar_domain_discovery_check` and
  `create_sandbox_registrar_domain_discovery_check` now reject an empty
  `domains` array before making a request, instead of sending a no-op
  availability check to Cloudflare.

No breaking changes. Existing calls that already supplied at least one
domain are unaffected.
