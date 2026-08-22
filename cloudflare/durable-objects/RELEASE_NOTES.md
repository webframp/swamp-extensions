## 2026.08.21.1

**Changed:** Error messages for API failures and invalid input are now
specific instead of generic.

- `list_namespaces` failures now report the account ID being queried instead
  of surfacing the raw Cloudflare API error with no context.
- `list_objects` failures now report the namespace ID and account ID involved
  instead of the bare SDK error.
- `list_objects` now rejects an empty `id` (namespace ID) argument up front
  with a clear validation error, instead of sending a malformed request to
  the Cloudflare API and failing deep inside the HTTP call with a cryptic
  404.

**Upgrade note:** No behavioral change for valid requests. Callers that were
passing an empty string for `id` will now get an immediate, descriptive
validation error instead of a Cloudflare API 404.
