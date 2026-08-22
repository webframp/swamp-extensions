## 2026.08.21.2

**Changed:**

- Errors raised when a Cloudflare API call fails now name the HTTP method
  and path that was attempted (e.g. `Cloudflare API POST
  /accounts/.../logpush/jobs failed with HTTP 400 ...`) instead of a bare
  `Cloudflare API error: ...`. Network-level failures (DNS, connection
  reset, timeout) are now also caught and wrapped with the same operation
  context instead of surfacing a raw `fetch` error.

No breaking changes.
