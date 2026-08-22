## 2026.08.21.2

**Changed:**
- `ban_user`, `unban_user`, and `get_user` now reject empty `userId`/`login`
  values before making any API call, instead of sending a blank ID to Twitch
  and surfacing whatever cryptic error Helix happens to return.
- `ban_user`'s `duration` (timeout length) is now validated against Twitch's
  actual limits — an integer between 1 second and 1,209,600 seconds (2
  weeks). Out-of-range values are rejected immediately with a clear message
  rather than failing deep in the Helix API call.
- `send_message` now enforces the documented 500-character limit on
  `message` (and rejects empty messages) instead of letting the API reject
  an oversized message after the request is already sent.
- `ban_user`'s `reason` field is capped at 500 characters to match Twitch's
  API limit.
- Errors raised by failed Helix API requests now name the HTTP method and
  path that was attempted (e.g. `GET /moderation/banned?... returned 404`)
  instead of just the status code and response body, making it clear which
  operation failed when multiple API calls happen in one method.

No behavioral changes for well-formed inputs — existing valid calls are
unaffected.
