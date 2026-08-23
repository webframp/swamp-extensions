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
# Store a secret (interactive prompt, value hidden)
swamp vault put keychain my-api-key

# Retrieve a secret
swamp vault read-secret keychain my-api-key --force --json

# Note: listing keys is not supported by macOS Keychain (see Troubleshooting)
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

## Troubleshooting

**`swamp vault list-keys` (or a `list()` call) always errors.** This is
expected, not a bug: `security` has no way to enumerate accounts for a given
service, so `list` in `keychain.ts` unconditionally rejects with "Listing
keychain items is not supported by this vault provider" and the span records
it as a failure. There is no config flag to work around this — track keys in
your model/workflow config instead of listing them from the vault.

**Runs everywhere except macOS.** The provider shells out to `security`,
which only exists on Darwin. `manifest.yaml` restricts `platforms` to
`darwin-x86_64` and `darwin-aarch64`; running on Linux or in most CI
containers will fail before the provider code even executes.

**"security ... exited with code ... <stderr>" mentioning the keychain being
locked or denying access.** `runSecurity` in `keychain.ts` wraps any non-zero
exit from the `security` CLI with its stderr text (with the submitted secret
value and its hex encoding redacted first). A locked login keychain, a
keychain-access prompt the CLI can't satisfy non-interactively, or the item
already existing without `-U` permissions typically surfaces here. Unlock the
keychain (`security unlock-keychain`) or grant access, then retry.

**"secret is too large for the keychain write path".** `put` hex-encodes the
value and writes an `add-generic-password ... -X <hex>` line to `security -i`
over stdin; that interface reads commands through a fixed 4096-byte line
buffer. The provider checks the encoded line length before spawning anything
and throws with the computed maximum byte count for your specific service/key
combination rather than silently truncating or corrupting the write. Shorten
the service name, the key, or the secret.

**"could not determine keychain password encoding: ...".** On macOS 26,
`find-generic-password -w` prints hex instead of the literal secret when any
byte falls outside printable ASCII. `get` disambiguates by re-running with
`-g` and reading the `password:` line from stderr; this error means that
probe line was missing or contained malformed hex — for example if a
non-standard `security` build changed that output format. This is a hard
failure, not a fallback to raw output, because guessing wrong would return
corrupted bytes.

**A key or the configured `service` is rejected before `security` runs.**
Keys and the `service` config value are checked for control characters (a
newline would split the command line sent to `security -i`) and a leading
`-` (which `security` would parse as a flag). Both throw synchronously in
`assertSafeKey` / the config schema's `refine` before any subprocess spawns.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
