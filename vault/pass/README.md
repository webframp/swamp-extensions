# @webframp/pass

GPG-encrypted password store vault provider for
[swamp](https://github.com/systeminit/swamp), backed by the
[pass](https://www.passwordstore.org/) CLI.

## Prerequisites

- [pass](https://www.passwordstore.org/) installed and initialized
  (`pass init <gpg-id>`)
- A GPG key configured for encryption/decryption

## Installation

```bash
swamp extension pull @webframp/pass
```

## Configuration

Add the vault to your `.swamp.yaml`:

```yaml
vaults:
  my-secrets:
    type: "@webframp/pass"
    config:
      # Every setting is optional; the values shown are the defaults.

      # Override the password store directory (defaults to ~/.password-store)
      # storeDir: "/path/to/custom/.password-store"

      # Key prefix for namespacing (defaults to "swamp").
      # Set to "" to disable prefixing.
      prefix: "swamp"

      # Extra environment variable names to forward to the pass subprocess,
      # for GPG or pinentry setups that need something unusual.
      extraEnv: []

      # Return only line 1 of each entry (defaults to false).
      passwordOnly: false

      # Enable per-key field selection, e.g. "smtp/example#login".
      # Unset by default, so keys are taken literally.
      # fieldSeparator: "#"
```

With the default `prefix: "swamp"`, a secret named `db/password` is stored as
`swamp/db/password` in the pass store. Set `prefix: ""` to store keys without a
namespace.

Keys are validated before the CLI runs. A key must be relative, non-empty, and
free of `.` or `..` path segments, so it cannot reach a secret outside the
configured prefix.

## Multiline entries

By default `get` returns the whole decrypted entry, every line of it, with only
the final newline removed. pass convention puts the password on line 1 and
optional `name: value` metadata on the lines after it:

```text
s3cr3t-value
login: user@example.com
host: smtp.example.com
```

Wiring that entry into a password or API token hands the consumer the secret
plus all its metadata, which looks like a wrong password at the far end. Two
opt-in settings narrow what `get` returns.

**`passwordOnly: true`** returns line 1 only (`s3cr3t-value` above), for every
key the vault serves. Spaces and tabs on that line are kept; the line terminator
is not.

**`fieldSeparator`** lets each key select a metadata field. With
`fieldSeparator: "#"`:

| Key                  | Returns                                        |
| -------------------- | ---------------------------------------------- |
| `smtp/example`       | the whole entry, or line 1 with `passwordOnly` |
| `smtp/example#login` | `user@example.com`                             |
| `smtp/example#host`  | `smtp.example.com`                             |

Field names match case-insensitively, and only lines after line 1 are searched,
so a password containing a colon is never read as a field. A line such as
`otpauth://totp/...` is a URI, not a field, so `#otpauth` does not match it. The
first matching line wins. Whitespace after the colon is dropped; trailing
whitespace is kept. A field the entry lacks is an error that names the entry and
field but never quotes the entry.

The key splits at the last occurrence of the separator. The text after it
selects a field only if it is a field name: non-blank, free of `/` and `:`, and
without whitespace at either end. Otherwise the whole key names an entry, so
`team#a/entry` and `a#` read those entries. An entry whose name does end in the
separator and a field name, such as `smtp#login`, can never be read whole: `get`
reads the `login:` field of `smtp` instead. Choose a separator that never
appears in your entry names. The separator itself may not contain `/` or
whitespace.

With `passwordOnly` or a field selection, a key that names a directory is an
error. Without them, `get` returns whatever `pass show` prints, which for a
directory is its tree listing. `put` refuses a key that selects a field, since
writing it would replace the whole entry.

```yaml
globalArgs:
  smtpUser:
    source: vault
    vault: my-secrets
    key: smtp/example#login
```

## Subprocess environment

The `pass` subprocess receives only the environment variables that pass and GPG
need — `HOME`, `PATH`, the locale variables, the `GNUPGHOME` and `GPG_*` agent
variables, the display and session variables pinentry uses, and the
`PASSWORD_STORE_*` settings. Everything else in the swamp process environment,
including credentials for unrelated systems, stays out of the subprocess and out
of any GPG hook it invokes.

If your GPG or pinentry setup needs a variable outside that set, name it in
`extraEnv` rather than waiting for a release.

## Usage

Store and retrieve secrets using swamp vault expressions or the CLI:

```bash
# Store a secret (interactive prompt, value hidden)
swamp vault put my-secrets db/password

# Retrieve a secret
swamp vault read-secret my-secrets db/password --force --json

# List all keys under the configured prefix
swamp vault list-keys my-secrets --json
```

Reference secrets in model definitions with vault expressions:

```yaml
globalArgs:
  apiToken:
    source: vault
    vault: my-secrets
    key: api/token
```

## Upgrading from 2026.04.13.1

Version 2026.04.22.1 introduces key prefixing (default `"swamp"`). Secrets
stored by earlier versions have no prefix. To access them without migration, set
`prefix: ""` in your vault config.

## Observability

The provider emits OpenTelemetry spans for every vault operation — `pass get`,
`pass put`, and `pass list`. It uses `@opentelemetry/api` only and never
configures a TracerProvider; the swamp host does that. With no provider
configured the tracer is a no-op.

Attributes: `vault.name`, `vault.secret_key`, `vault.secret_field` when a get or
put key selects a field, `vault.prefix` when a prefix is configured,
`rpc.system`, `rpc.service`, `rpc.method`, and `vault.keys_returned` on `list`.

These spans cover a case the host does not. swamp emits its own `swamp.vault.*`
spans when you run a `swamp vault` subcommand, but they carry no attributes, and
when a model or workflow resolves a vault expression the host emits no vault
span at all — the read is invisible. The extension's spans appear on both paths.

There is no span around the `pass` or `find` invocations. Each method is one
subprocess call, so a child span would only restate its parent, and keeping span
code out of the exec helper means argv and stdin — which hold the plaintext —
are never in scope where a span could record them.

**What is never recorded:** secret values, argv, stdin, and error messages. On
failure a span carries `error.type` and an ERROR status, nothing more.
`recordException` is not used, because it publishes the message and stack of an
error whose text is the CLI's stderr.

**Key names are recorded.** `vault.secret_key` holds the key, because a vault
span without it is close to useless for debugging. Treat key names as visible to
anyone with access to your trace backend, and do not encode sensitive
information in them.

## Troubleshooting

**"pass ... exited with code 127" or similar, no `pass`-specific detail.**
`runPass` spawns `pass` with `clearEnv: true` and only the variables in
`ENV_ALLOWLIST` (plus `extraEnv`) — if `pass` (or `gpg`) isn't installed, or
isn't reachable via the narrowed `PATH` that got forwarded, the subprocess fails
immediately and the wrapped error carries whatever the shell reported, not a
gopass/pass-specific message. Confirm `pass` and `gpg` resolve inside the same
`PATH` value your environment forwards, not just your interactive shell's.

**GPG/pinentry hangs or fails after upgrading, worked fine before.** The
subprocess environment used to be the full parent environment; it's now narrowed
to `ENV_ALLOWLIST` in `pass.ts` — `HOME`, `PATH`, GPG/pinentry variables
(`GNUPGHOME`, `GPG_TTY`, `DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, etc.), and the
`PASSWORD_STORE_*` settings. An unusual pinentry setup that needs a variable
outside that list (a custom pinentry program's own env var, for instance) will
silently lose it. Add the variable name to `extraEnv` in the vault config rather
than waiting for a broader default allowlist.

**"pass list failed: find `<storeDir>` exited with code ...".** `list` shells
out to `find` separately from `pass`, and a non-zero exit from `find` is
deliberately not treated as "the store has no secrets" — that case is a zero
exit with empty output, handled separately. A non-zero `find` exit means the
store directory is missing, unreadable, or `find` itself isn't installed; check
`storeDir` (or `PASSWORD_STORE_DIR`) points at a real, readable directory.

**A key is rejected before `pass` runs.** `assertSafeKey` throws for keys that
are empty, start with `/` or `-`, contain a null byte, or contain a `.` or `..`
path segment — these would otherwise let a caller escape the configured `prefix`
and read or overwrite a secret elsewhere in the store. With `fieldSeparator`
set, the check applies to the entry path left after the field is split off, so
`#login` fails as an empty key, and `put` rejects any key that selects a field.

**Secrets from before 2026.04.22.1 return "not found".** Version 2026.04.22.1
introduced key prefixing with a default of `"swamp"`. Every `get`/`put`/`list`
call is now scoped under that prefix (`swamp/<key>` in the underlying store), so
secrets inserted by an earlier version — which had no prefix — won't be found
under the new default. Set `prefix: ""` in the vault config to read them without
migrating.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
