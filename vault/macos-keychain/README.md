# @webframp/macos-keychain

A swamp vault provider that stores and retrieves secrets using the macOS
Keychain via the `security` command-line tool. Secrets are persisted as generic
password items, scoped by a configurable service name, and protected by the
operating system's native credential storage.

## Prerequisites

- macOS (Darwin) operating system
- The `security` CLI, which ships with every macOS installation

## Installation

```bash
swamp extension pull @webframp/macos-keychain
```

## Configuration

Add the vault to your `.swamp.yaml`:

```yaml
vaults:
  keychain:
    type: "@webframp/macos-keychain"
    config:
      service: "swamp" # optional, defaults to "swamp"
```

The `service` field controls the Keychain service name under which all secrets
are stored. If you omit it, the provider defaults to `"swamp"`.

## Usage

Store and retrieve secrets with the `swamp vault` CLI:

```bash
# Store a secret
swamp vault put keychain my-api-key "sk-live-abc123"

# Retrieve a secret
swamp vault get keychain my-api-key

# Note: listing keys is not supported by macOS Keychain
```

## Vault Expressions in Models

Reference vault secrets in model definitions using the `vault://` expression
syntax:

```yaml
globalArgs:
  apiToken:
    type: string
    default: "vault://keychain/my-api-key"
```

When a method runs, swamp resolves `vault://keychain/my-api-key` by calling the
provider's `get("my-api-key")` method automatically.

## Supported Platforms

This extension runs only on macOS:

- `darwin-x86_64`
- `darwin-aarch64`

## Observability

The provider emits OpenTelemetry spans for every vault operation — `Keychain
get`, `Keychain put`, and `Keychain list`. It uses `@opentelemetry/api` only and
never configures a TracerProvider; the swamp host does that. With no provider
configured the tracer is a no-op.

Attributes: `vault.name`, `vault.secret_key`, `vault.service`, `rpc.system`,
`rpc.service`, and `rpc.method`. `list` is unsupported by this provider, so its
span reports ERROR — a caller asked for a listing and did not get one.

These spans cover a case the host does not. swamp emits its own `swamp.vault.*`
spans when you run a `swamp vault` subcommand, but they carry no attributes, and
when a model or workflow resolves a vault expression the host emits no vault span
at all — the read is invisible. The extension's spans appear on both paths.

There is no span around the `security` invocation itself. `put` passes the secret
as the `-w` argument, so keeping span code out of the exec helper means argv is
never in scope where a span could record it. A test asserts the secret really is
present in argv and absent from every span field.

**What is never recorded:** secret values, argv, and error messages. On failure a
span carries `error.type` and an ERROR status, nothing more. `recordException` is
not used, because it publishes the message and stack of an error whose text is
`security`'s stderr.

**Key names are recorded.** `vault.secret_key` holds the key, because a vault
span without it is close to useless for debugging. Treat key names as visible to
anyone with access to your trace backend, and do not encode sensitive
information in them.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
