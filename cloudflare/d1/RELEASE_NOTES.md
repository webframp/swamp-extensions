## 2026.08.21.1

**Changed:** Error messages for API failures and invalid input are now
specific instead of generic.

- Every method that calls the Cloudflare API now wraps failures with the
  operation and the database/account ID involved, instead of surfacing the
  raw SDK error with no context.
- All methods that take a `database_id` now reject an empty value up front
  with a clear validation error, instead of sending a malformed request to
  the Cloudflare API.
- `create_database` now validates that `name` is present before calling the
  API, instead of letting Cloudflare reject the request with a generic
  error.
- `d1_time_travel_restore` now requires either `bookmark` or `timestamp` to
  be supplied, instead of silently sending a restore request with neither
  and letting Cloudflare reject it.

**Upgrade note:** No behavioral change for valid requests. Callers relying on
an empty `database_id`, a missing `name` on create, or a restore request with
neither `bookmark` nor `timestamp` to fail inside the Cloudflare API call will
now get an immediate, descriptive validation error instead.
