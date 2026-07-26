## 2026.07.26.2

**Added:** OpenTelemetry spans on `get`, `put`, and `list`, named `gopass get`,
`gopass put`, and `gopass list`. Attributes: `vault.name`, `vault.secret_key`,
`vault.store` when a store is configured, `rpc.system`, `rpc.service`,
`rpc.method`, and `vault.keys_returned` on `list`.

This closes a real observability gap rather than duplicating the host. swamp
emits `swamp.vault.*` spans when a human runs a `swamp vault` subcommand, with
no attributes at all — and emits **nothing** when a model or workflow resolves a
vault expression. A secret read during a run was invisible in traces. These
spans appear on both paths.

The extension uses `@opentelemetry/api` only and never constructs a
TracerProvider. With no provider configured the tracer is a no-op and the cost is
a few property lookups.

There are deliberately no spans around the `gopass` invocation itself. Each
public method is exactly one CLI call, so a child span would be a renamed
duplicate of its parent, and keeping span code out of the exec helper means no
edit can attach argv or stdin — which hold the plaintext — to a span.

**Changed:** Error messages no longer echo a submitted secret value. If `gopass`
fails an `insert` and quotes the value back on stderr, that value is replaced
with `[redacted]` before the message is thrown. The swamp host publishes thrown
error messages into its own span as a status description, an `exception.message`,
and a stack trace, so an echoed value reached the trace backend regardless of
what this extension recorded.

**Note on what spans deliberately omit:** spans record `error.type` and an ERROR
status on failure, and never `recordException` and never a status description. A
gopass error message is the CLI's stderr, which this extension does not control,
and the host already publishes it once. Recording key names is intentional — a
vault span without the key is close to useless for debugging — so treat key names
as visible to anyone with access to your trace backend. gopass's own
documentation advises against putting sensitive data in secret names; that advice
now has a second reason behind it.
