## 2026.08.21.2

**Changed:** Error messages for API failures and invalid input are now
specific instead of generic.

- Every method that calls the Cloudflare API now wraps failures with the
  operation attempted and the account/identifier involved (e.g.
  `certificate_id`, `list_id`, `location_id`, `pacfile_id`,
  `proxy_endpoint_id`, `rule_id`), instead of surfacing the raw SDK error
  with no context.
- Methods that take a `certificate_id`, `list_id`, `location_id`,
  `operation_id`, `pacfile_id`, `proxy_endpoint_id`, or `rule_id` now reject
  an empty value up front with a clear validation error, instead of sending
  a malformed request to the Cloudflare API.

**Upgrade note:** No behavioral change for valid requests. Callers passing an
empty identifier will now get an immediate, descriptive validation error
instead of a Cloudflare API failure.
