## 2026.07.26.2

**Added:** OpenTelemetry spans on `get`, `put`, and `list`, named `Keychain get`,
`Keychain put`, and `Keychain list`. Attributes: `vault.name`,
`vault.secret_key`, `vault.service`, `rpc.system`, `rpc.service`, and
`rpc.method`. `list` is unsupported by this provider and its span reports ERROR,
which is honest: a caller asked for a listing and did not get one.

This closes a real observability gap rather than duplicating the host. swamp
emits `swamp.vault.*` spans when a human runs a `swamp vault` subcommand, with
no attributes at all — and emits **nothing** when a model or workflow resolves a
vault expression. A secret read during a run was invisible in traces. These
spans appear on both paths.

The extension uses `@opentelemetry/api` only and never constructs a
TracerProvider. With no provider configured the tracer is a no-op and the cost is
a few property lookups.

There are deliberately no spans around the `security` invocation itself. `put`
passes the secret as the `-w` argument, so keeping span code out of the exec
helper means no edit can attach argv to a span. A test asserts the secret is
genuinely present in argv and absent from every span field.

**Changed:** Error messages no longer echo the submitted secret. `security`
receives the value as a command-line argument, and a CLI that rejects an argument
commonly quotes it back on stderr — that stderr was the thrown error message
verbatim. The value is now replaced with `[redacted]` first. This matters beyond
this extension's own spans: the swamp host publishes thrown error messages into
its span as a status description, an `exception.message`, and a stack trace, so
an echoed secret reached the trace backend with no instrumentation involved at
all.

**Still outstanding — the secret is passed as a command-line argument.** `put`
invokes `security add-generic-password … -w <secret>`, and process arguments are
readable by other processes running as the same user. Tracked in #275 along with
the macOS 26 hex-encoding of `find-generic-password -w` output. Neither can be
verified without a Mac, and a wrong guess breaks the write path for every user.

**Note on what spans deliberately omit:** spans record `error.type` and an ERROR
status on failure, and never `recordException` and never a status description. A
keychain error message is `security`'s stderr, and the host already publishes it
once. Recording key names is intentional — a vault span without the key is close
to useless for debugging — so treat key names as visible to anyone with access to
your trace backend and do not encode sensitive information in them.
