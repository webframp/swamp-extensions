## 2026.08.21.3

**Changed:**

- Errors raised when a Cloudflare API call fails now name the HTTP method
  and path that was attempted (e.g. `Cloudflare API POST
  /accounts/.../pages/projects failed with HTTP 400 ...`) instead of a bare
  `Cloudflare API error: ...`. Network-level failures (DNS, connection
  reset, timeout) are now also caught and wrapped with the same operation
  context instead of surfacing a raw `fetch` error.
- `create_project` now rejects an empty `name` or `production_branch`
  before making a request, instead of letting Cloudflare reject the
  request with a less specific error.

No breaking changes. Existing calls that already supplied a non-empty
`name` and `production_branch` are unaffected.
