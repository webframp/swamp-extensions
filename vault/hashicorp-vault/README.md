# @webframp/hashicorp-vault

HashiCorp Vault KV secrets engine provider for swamp. This extension integrates
swamp with a HashiCorp Vault server, allowing you to store, retrieve, and list
secrets through the Vault REST API. It supports both KV v1 and KV v2 secrets
engines, custom mount paths, and Vault Enterprise namespaces.

## Prerequisites

- A running HashiCorp Vault server (self-hosted or HCP Vault)
- A valid Vault token with read/write access to the target KV engine
- The `VAULT_ADDR` environment variable or an explicit address in your swamp
  configuration

## Installation

```bash
swamp extension pull @webframp/hashicorp-vault
```

## Configuration

Add a vault entry to your `.swamp.yaml` to wire up the provider:

```yaml
vaults:
  hashi:
    type: "@webframp/hashicorp-vault"
    config:
      address: "https://vault.example.com:8200"
      token: "hvs.CAESI..."
      mount: "secret" # default: "secret"
      kvVersion: "2" # "1" or "2" (default: "2")
      namespace: "admin" # optional, Vault Enterprise only
```

## Usage

Once configured, interact with secrets through the standard `swamp vault` CLI
commands:

```bash
# Store a secret (interactive prompt, value hidden)
swamp vault put hashi my-app/db-password

# Retrieve a secret
swamp vault read-secret hashi my-app/db-password --force --json

# List all secrets
swamp vault list-keys hashi --json
```

## Vault expressions in model definitions

Reference vault secrets inside model resource definitions using the `vault()`
expression:

```yaml
resources:
  database:
    type: postgres
    properties:
      host: db.example.com
      password: "{{ vault('hashi', 'my-app/db-password') }}"
```

## How it works

The provider communicates with the Vault HTTP API. For KV v2 engines it uses the
`/v1/<mount>/data/<key>` and `/v1/<mount>/metadata/<key>` paths; for KV v1 it
uses `/v1/<mount>/<key>` directly. Secrets with a single `value` field are
returned as plain strings; multi-field secrets are returned as JSON.

## Observability

The provider emits OpenTelemetry spans for every vault operation. It uses
`@opentelemetry/api` only and never configures a TracerProvider — the swamp host
does that. With no provider configured the tracer is a no-op.

| Span         | When                                          |
| ------------ | --------------------------------------------- |
| `Vault get`  | reading a secret                              |
| `Vault put`  | writing a secret                              |
| `Vault list` | enumerating keys                              |
| `Vault LIST` | one per HTTP request in the recursive walk     |

Attributes: `vault.name`, `vault.secret_key`, `vault.kv_version`, `rpc.system`,
`rpc.service`, `rpc.method`, `vault.keys_returned` on `list`, `vault.truncated`
on `list`, and `vault.list_depth` on each child request.

`list` walks the metadata tree with a depth cap of 10 and a key cap of 10000.
`vault.truncated` is true when a cap stopped the walk, so a listing that gave up
can be told apart from an empty mount.

These spans cover a case the host does not. swamp emits its own `swamp.vault.*`
spans when you run a `swamp vault` subcommand, but they carry no attributes, and
when a model or workflow resolves a vault expression the host emits no vault span
at all — the read is invisible. The extension's spans appear on both paths and
nest under whatever the host is doing.

**What is never recorded:** secret values, the Vault token, request and response
bodies, and error messages. On failure a span carries `error.type` and an ERROR
status, nothing more. `recordException` is not used, because it publishes the
message and stack of an error whose text comes from Vault rather than from this
extension — and the host already publishes that text once.

**Key names are recorded.** `vault.secret_key` holds the key, because a vault
span without it is close to useless for debugging. Treat key names as visible to
anyone with access to your trace backend, and do not encode sensitive
information in them.

**Verified against the runtime.** The no-token/no-body guarantee was empirically
confirmed against swamp `20260725.210408.0` and Deno 2.7.14: Deno's fetch
auto-instrumentation is present in the binary but inactive, so `X-Vault-Token`
and request bodies never enter a span. This property depends on fetch
instrumentation remaining disabled in the swamp host. If a future swamp or Deno
release activates it, the token becomes a span attribute that nothing in this
extension can suppress. See
[#276](https://github.com/webframp/swamp-extensions/issues/276) for the full
probe methodology and residual risk inventory.

## Troubleshooting

**"No Vault token found."** `resolveToken` in `hashicorp.ts` checks, in order,
the config `token` field, the `VAULT_TOKEN` environment variable, and
`~/.vault-token` (the file `vault login` writes). If none resolve, the
provider throws before making any HTTP request, with a message that spells
out all three sources. This is a client-side check, not a Vault server error
— it fires even if the server is unreachable.

**"Vault get request failed: could not reach `<url>`: ..."** This message
comes from `vaultFetch`, which wraps DNS, connection-refused, and TLS
failures with the operation and key involved. It fires before any HTTP status
exists — a `handleResponse`-shaped "Vault get failed: 4xx/5xx" message means
the request *reached* Vault; this one means it never did. Check `address` in
the vault config and that the server is actually listening there.

**"Secret '`<key>`' not found or has no data."** `get` reads the response
differently depending on `kvVersion`: KV v2 nests the payload under
`data.data`, KV v1 under `data` directly. If `kvVersion` in the config doesn't
match how the mount was actually created, the code looks in the wrong place
and throws this error even though the secret exists — it looks identical to a
genuinely missing key. Verify the mount's actual KV version with
`vault secrets list -detailed` on the server.

**A key is rejected before any request is sent.** `assertSafeKey` throws for
keys that are empty, start with `/`, contain a null byte, or contain a `.` or
`..` path segment — this stops a key from being interpolated into the request
path in a way that reaches a different mount or a different Vault API
entirely (e.g. `secret/data/../../sys`).

**`list` returns fewer keys than expected with no error.** The recursive walk
in `list` stops at `MAX_DEPTH = 10` or `MAX_KEYS = 10000` and does not throw
— it silently caps and sets `vault.truncated` on the emitted span instead
(see Observability below). A deeply nested or very large secret tree can hit
either cap; check the span attribute rather than assuming the listing is
complete.

**Vault API errors show the server's own error list.** `handleResponse`
parses the JSON error body Vault returns on non-2xx responses and surfaces
`parsed.errors.join(", ")` in the thrown message when present, falling back
to a generic `<status> <statusText>` line only when the body isn't the
expected shape (e.g. an upstream proxy error page instead of a Vault JSON
error).

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
