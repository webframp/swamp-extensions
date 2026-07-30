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

## Security and Limits

**The secret never appears in process arguments.** `put` hex-encodes the value
and feeds `add-generic-password ... -X <hex>` to `security -i` on stdin.
Process arguments are readable by any process running as the same user, so an
argv-based write would expose every secret to `ps` and to endpoint monitoring
agents; the stdin path does not.

**Maximum secret size is about 2 KB.** The `security -i` interface reads
commands with a 4096-byte line buffer, which caps a hex-encoded secret at
roughly 2 KB (the exact figure depends on the service and key length).
Oversize writes fail with a descriptive error before anything is executed.
Reads are not size-limited by this; larger existing items still round-trip.

**macOS 26 hex output is handled.** On macOS 26,
`find-generic-password -w` prints hex instead of the secret when any byte
falls outside printable ASCII. `get` detects this through `-g`, which marks
the encoding explicitly, and decodes only when the keychain says the output is
hex. A secret whose value merely looks like hex (`deadbeef`) is returned
verbatim.

**Keys and the service name must not contain control characters.** A newline
would split the command line sent to `security -i`. Keys must also not start
with `-`.

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

There is no span around the `security` invocation itself. `put` hands the
hex-encoded secret to `security -i` on stdin, so keeping span code out of the
exec helper means neither argv nor stdin is in scope where a span could record
it. A test asserts the secret and its hex encoding are absent from argv and
from every span field.

**What is never recorded:** secret values, argv, stdin, and error messages. On
failure a span carries `error.type` and an ERROR status, nothing more.
`recordException` is not used, because it publishes the message and stack of an
error whose text is `security`'s stderr — and `security -i` echoes rejected
input back on stderr, so thrown messages additionally have the submitted value
redacted.

**Key names are recorded.** `vault.secret_key` holds the key, because a vault
span without it is close to useless for debugging. Treat key names as visible to
anyone with access to your trace backend, and do not encode sensitive
information in them.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
