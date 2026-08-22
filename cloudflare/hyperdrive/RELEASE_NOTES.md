## 2026.08.21.1

**Changed:** Error messages for API failures and invalid input are now
specific instead of generic.

- `list_hyperdrive`, `get_hyperdrive`, `create_hyperdrive`, `update_hyperdrive`,
  `patch_hyperdrive`, and `delete_hyperdrive` now wrap Cloudflare API failures
  with the operation and the account/config ID involved, instead of
  surfacing the raw SDK error with no context.
- `get_hyperdrive`, `update_hyperdrive`, `patch_hyperdrive`, and
  `delete_hyperdrive` now reject an empty `hyperdrive_id` up front with a
  clear validation error, instead of sending a malformed request to the
  Cloudflare API.
- `create_hyperdrive` now validates that `name` and `origin` are present
  before calling the API, instead of letting Cloudflare reject the request
  deep inside the HTTP call with a generic error.

**Upgrade note:** No behavioral change for valid requests. Callers relying on
an empty `hyperdrive_id`, or a missing `name`/`origin` on create, to fail
inside the Cloudflare API call will now get an immediate, descriptive
validation error instead.
