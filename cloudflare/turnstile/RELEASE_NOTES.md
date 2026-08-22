## 2026.08.21.1

**Changed:** Errors and validation now say what went wrong and where.

- Cloudflare API failures (HTTP errors and `success: false` API responses) now
  name the HTTP method and path that was attempted, in addition to the
  original status/message. Previously the error read only
  `Cloudflare API error: <message>`, with no indication of which endpoint the
  method call was hitting — now it reads
  `Cloudflare API request failed: GET /accounts/<account>/challenges/widgets/<sitekey>: <message>`.
  This applies to every method on this model, since they all share the same
  request helper.
- `sitekey` is now validated as non-empty before any request is made. Passing
  an empty string previously sent a request to a malformed URL and produced a
  confusing 404 from Cloudflare; it now fails fast with
  `sitekey must not be empty`.

**Upgrade note:** No method was added, removed, or renamed. Existing callers
that always pass a non-empty `sitekey` see no behavioral change beyond
clearer error text.
