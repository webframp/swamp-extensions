## 2026.08.21.1

**Changed:** Error messages for API failures and invalid input are now
specific instead of generic.

- Every method that calls the Cloudflare API now wraps failures with the
  operation attempted and the zone/identifier involved (e.g. `discovery_id`,
  `operation_id`, `name`), instead of surfacing the raw SDK error with no
  context.
- Methods that take a `discovery_id`, `operation_id`, or `name` now reject an
  empty value up front with a clear validation error, instead of sending a
  malformed request to the Cloudflare API and failing deep inside the HTTP
  call.

**Upgrade note:** No behavioral change for valid requests. Callers passing an
empty identifier will now get an immediate, descriptive validation error
instead of a Cloudflare API failure.
