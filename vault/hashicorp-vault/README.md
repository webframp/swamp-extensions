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
# Store a secret
swamp vault put hashi my-app/db-password "s3cret!"

# Retrieve a secret
swamp vault get hashi my-app/db-password

# List all secrets
swamp vault list hashi
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

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
