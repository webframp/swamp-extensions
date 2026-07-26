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
# Optional: override the default password store directory
# storeDir: "/path/to/custom/.password-store"

# Optional: key prefix for namespacing (defaults to "swamp")
# Set to "" to disable prefixing
# prefix: "myproject"

# Optional: extra environment variable names to forward to the pass
# subprocess, for GPG or pinentry setups that need something unusual
# extraEnv: ["MY_PINENTRY_SOCKET"]
```

With the default `prefix: "swamp"`, a secret named `db/password` is stored as
`swamp/db/password` in the pass store. Set `prefix: ""` to store keys without a
namespace.

Keys are validated before the CLI runs. A key must be relative, non-empty, and
free of `.` or `..` path segments, so it cannot reach a secret outside the
configured prefix.

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
# Store a secret
swamp vault set my-secrets db/password "s3cret"

# Retrieve a secret
swamp vault get my-secrets db/password

# List all keys under the configured prefix
swamp vault list my-secrets
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

Attributes: `vault.name`, `vault.secret_key`, `vault.prefix` when a prefix is
configured, `rpc.system`, `rpc.service`, `rpc.method`, and
`vault.keys_returned` on `list`.

These spans cover a case the host does not. swamp emits its own `swamp.vault.*`
spans when you run a `swamp vault` subcommand, but they carry no attributes, and
when a model or workflow resolves a vault expression the host emits no vault span
at all — the read is invisible. The extension's spans appear on both paths.

There is no span around the `pass` or `find` invocations. Each method is one
subprocess call, so a child span would only restate its parent, and keeping span
code out of the exec helper means argv and stdin — which hold the plaintext — are
never in scope where a span could record them.

**What is never recorded:** secret values, argv, stdin, and error messages. On
failure a span carries `error.type` and an ERROR status, nothing more.
`recordException` is not used, because it publishes the message and stack of an
error whose text is the CLI's stderr.

**Key names are recorded.** `vault.secret_key` holds the key, because a vault
span without it is close to useless for debugging. Treat key names as visible to
anyone with access to your trace backend, and do not encode sensitive
information in them.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
