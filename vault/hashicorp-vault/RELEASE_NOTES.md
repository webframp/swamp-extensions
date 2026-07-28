## 2026.07.27.1

**Changed:** Bump @opentelemetry/api 1.9.0 → 1.9.1

## 2026.07.26.2

**Added:** OpenTelemetry spans on `get`, `put`, and `list`, plus one child span
per HTTP request inside the recursive `list` walk. Span names are `Vault get`,
`Vault put`, `Vault list`, and `Vault LIST` for the child requests. Attributes:
`vault.name`, `vault.secret_key`, `vault.kv_version`, `rpc.system`,
`rpc.service`, `rpc.method`, `vault.keys_returned` on `list`,
`vault.truncated` on `list` when the depth or key cap stopped the walk, and
`vault.list_depth` on each child request.

This closes a real observability gap rather than duplicating the host. swamp
emits `swamp.vault.*` spans when a human runs a `swamp vault` subcommand, with
no attributes at all — and emits **nothing** when a model or workflow resolves a
vault expression. A secret read during a run was invisible in traces. These
spans appear on both paths.

The extension uses `@opentelemetry/api` only and never constructs a
TracerProvider. With no provider configured the tracer is a no-op and the cost is
a few property lookups.

**Changed:** Error messages no longer echo a submitted secret value. If Vault
rejects a write and quotes the value back in its `errors` array, that value is
replaced with `[redacted]` before the message is thrown. This matters because
the swamp host publishes thrown error messages into its own span as a status
description, an `exception.message`, and a stack trace — so an echoed value
reached the trace backend regardless of what this extension recorded.

**Changed:** `list` now reads and discards the response body on a 404 instead of
dropping the `Response` unread, which leaked a connection per missing path.

**Note on what spans deliberately omit:** spans record `error.type` and an ERROR
status on failure, and never `recordException` and never a status description. A
vault error message is built from output this extension does not control, and the
host already publishes it once. Recording key names is intentional — a vault span
without the key is close to useless for debugging — so treat key names as visible
to anyone with access to your trace backend and do not encode sensitive
information in them.
