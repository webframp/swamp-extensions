## 2026.08.21.1

**Changed:** Error messages for API failures and invalid input are now
specific instead of generic.

- Every method that calls the Cloudflare API now wraps failures with the
  operation attempted and the account/identifier involved (e.g. `app_id`,
  `user_id`, `identity_provider_id`, `service_token_id`, `certificate_id`,
  `policy_id`, `group_id`, `custom_page_id`), instead of surfacing the raw
  SDK error with no context.
- Methods that take an `app_id`, `user_id`, `id`, `identity_provider_id`,
  `service_token_id`, `certificate_id`, `tag_name`, `policy_id`, `group_id`,
  `custom_page_id`, `policy_test_id`, `hostname`, `nonce`, or
  `authenticator_id` now reject an empty value up front with a clear
  validation error, instead of sending a malformed request to the
  Cloudflare API.

**Upgrade note:** No behavioral change for valid requests. Callers passing an
empty identifier will now get an immediate, descriptive validation error
instead of a Cloudflare API failure.
