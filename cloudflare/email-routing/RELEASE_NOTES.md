## 2026.08.21.1

**Changed:** Error messages for API failures and invalid input are now
specific instead of generic.

- Every method that calls the Cloudflare API now wraps failures with the
  operation attempted and the zone/identifier involved (e.g.
  `rule_identifier`, `suppression_id`, `subdomain_id`), instead of surfacing
  the raw SDK error with no context.
- Methods that take a `rule_identifier`, `suppression_id`, or `subdomain_id`
  now reject an empty value up front with a clear validation error.
- `create_post_publicnewsuppressionzonerouting` and
  `create_post_publicnewsuppressionzonesending` now validate that `email` is
  a well-formed email address before calling the API.
- `create_sending_subdomain` and
  `create_email_sending_subdomains_preview_sending_subdomain` now reject an
  empty `name`.

**Upgrade note:** No behavioral change for valid requests. Callers passing an
empty identifier, a malformed email address, or an empty subdomain name will
now get an immediate, descriptive validation error instead of a Cloudflare
API failure.
