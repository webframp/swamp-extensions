## 2026.08.21.2

**Changed:**

- Errors raised when a Cloudflare API call fails now name the HTTP method
  and path that was attempted (e.g. `Cloudflare API POST
  /accounts/.../queues/xxx/messages/ack failed with HTTP 400 ...`) instead
  of a bare `Cloudflare API error: ...`. Network-level failures (DNS,
  connection reset, timeout) are now also caught and wrapped with the same
  operation context instead of surfacing a raw `fetch` error.
- `create_queues_ack_messages` and `create_queues_ack_preview_messages` now
  reject requests where both `acks` and `retries` are empty, since such a
  request has no effect on the queue.
- `create_queues_push_messages` now rejects an empty `messages` array
  before making a request, instead of sending a no-op batch to Cloudflare.

No breaking changes. Existing calls that already supplied at least one ack,
retry, or message are unaffected.
