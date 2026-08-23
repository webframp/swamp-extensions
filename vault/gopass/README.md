# @webframp/gopass

A swamp vault extension that integrates with [gopass](https://gopass.pw), the
pass-compatible password manager with extra features. This extension allows
swamp to retrieve, store, and list secrets managed by gopass, supporting
multiple stores/mounts and optional password-only mode that returns just the
first line of a secret entry.

## Prerequisites

- [gopass](https://github.com/gopasspw/gopass) CLI installed and initialized
- A GPG key configured for gopass encryption
- At least one initialized gopass store

## Installation

```bash
swamp extension pull @webframp/gopass
```

## Configuration

Add a vault entry to your `.swamp.yaml` to configure the gopass provider:

```yaml
vaults:
  - name: default
    type: "@webframp/gopass"
    config:
      store: "" # Optional: mount/store name (omit or leave empty for default store)
      passwordOnly: true # Return only the first line (password) of the secret
  - name: team-secrets
    type: "@webframp/gopass"
    config:
      store: "team" # Use the "team" mounted store
      passwordOnly: false # Return the full secret entry including metadata
```

## Usage

Once configured, use standard `swamp vault` CLI commands to interact with your
gopass secrets:

```bash
# List all secrets in the configured store
swamp vault list-keys default --json

# Retrieve a secret value
swamp vault read-secret default services/api-token --force --json

# Store a new secret (interactive prompt, value hidden)
swamp vault put default services/new-secret

# Use the team store
swamp vault list-keys team-secrets --json
swamp vault read-secret team-secrets shared/db-password --force --json
```

## Vault Expressions in Models

Reference gopass secrets in your model definitions using vault expressions:

```yaml
resources:
  database:
    type: postgres
    args:
      host: "db.example.com"
      username: "admin"
      password: "{{ vault \"default\" \"database/prod-password\" }}"
      api_key: "{{ vault \"team-secrets\" \"services/api-key\" }}"
```

## Observability

The provider emits OpenTelemetry spans for every vault operation — `gopass get`,
`gopass put`, and `gopass list`. It uses `@opentelemetry/api` only and never
configures a TracerProvider; the swamp host does that. With no provider
configured the tracer is a no-op.

Attributes: `vault.name`, `vault.secret_key`, `vault.store` when a store is
configured, `rpc.system`, `rpc.service`, `rpc.method`, and `vault.keys_returned`
on `list`.

These spans cover a case the host does not. swamp emits its own `swamp.vault.*`
spans when you run a `swamp vault` subcommand, but they carry no attributes, and
when a model or workflow resolves a vault expression the host emits no vault span
at all — the read is invisible. The extension's spans appear on both paths.

There is no span around the `gopass` invocation itself. Each method is one CLI
call, so a child span would only restate its parent, and keeping span code out of
the exec helper means argv and stdin — which hold the plaintext — are never in
scope where a span could record them.

**What is never recorded:** secret values, argv, stdin, and error messages. On
failure a span carries `error.type` and an ERROR status, nothing more.
`recordException` is not used, because it publishes the message and stack of an
error whose text is the CLI's stderr.

**Key names are recorded.** `vault.secret_key` holds the key, because a vault
span without it is close to useless for debugging. Treat key names as visible to
anyone with access to your trace backend — gopass's own documentation already
advises against putting sensitive data in secret names.

## Troubleshooting

**`gopass` not found on PATH.** The provider shells out via
`new Deno.Command("gopass", ...)` with no existence check beforehand. If the
binary isn't installed or isn't on the PATH swamp runs with, the failure
surfaces as a raw Deno "command not found"-style error rather than the
provider's own wrapped message — it never reaches the `code !== 0` handling in
`gopass.ts`, which only runs once a process actually spawns. Confirm with
`which gopass` in the same shell/environment swamp uses.

**"gopass show exited with code 1" with no further detail.** On a non-zero
exit, the thrown message is built from `args[0]` (just the subcommand, e.g.
`show`, `insert`, `list`) plus gopass's stderr — the full path and store
argument are deliberately left out of the message so a failure doesn't leak
the vault namespace to anyone with trace-backend read access. The stderr text
appended after the colon is where the real cause lives: a missing GPG key, an
uninitialized store, or a key that doesn't exist. If stderr was empty, gopass
printed nothing useful and the exit code alone is all that's available.

**A key is rejected before gopass ever runs.** `assertSafeKey` in `gopass.ts`
throws synchronously for keys that are empty, start with `/` or `-`, contain a
null byte, or contain a `.` or `..` path segment. These are rejected client-side
specifically so a key can't escape the configured `store` — a `..` segment
would otherwise let a caller read or overwrite a secret in a different
mount. Rename the key rather than working around the restriction.

**`get` returns only the first line even though the entry has more data.**
`passwordOnly` defaults to `true`, so `get` runs `gopass show -o -n <path>`,
which returns only the password line. If the secret entry has additional
lines (notes, TOTP seed, metadata), set `passwordOnly: false` in the vault
config to get the full entry via `gopass show -n <path>` instead.

**Listed keys look duplicated or missing the store prefix.** When `store` is
configured, `list` strips a leading `<store>/` from every key gopass returns
before handing them back — a store whose entries aren't actually organized
under that mount name will pass through unchanged rather than being trimmed,
which can make results look inconsistent between mounts.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
