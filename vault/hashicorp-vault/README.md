# @webframp/hashicorp-vault

HashiCorp Vault KV secrets engine provider for swamp. This extension
integrates swamp with a HashiCorp Vault server, allowing you to store,
retrieve, and list secrets through the Vault REST API. It supports both
KV v1 and KV v2 secrets engines, custom mount paths, and Vault Enterprise
namespaces.

## Prerequisites

- A running HashiCorp Vault server (self-hosted or HCP Vault)
- A valid Vault token with read/write access to the target KV engine
- The `VAULT_ADDR` environment variable or an explicit address in your
  swamp configuration

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
      mount: "secret"        # default: "secret"
      kvVersion: "2"         # "1" or "2" (default: "2")
      namespace: "admin"     # optional, Vault Enterprise only
```

## Usage

Once configured, interact with secrets through the standard `swamp vault`
CLI commands:

```bash
# Store a secret
swamp vault put hashi my-app/db-password "s3cret!"

# Retrieve a secret
swamp vault get hashi my-app/db-password

# List all secrets
swamp vault list hashi
```

## Vault expressions in model definitions

Reference vault secrets inside model resource definitions using the
`vault()` expression:

```yaml
resources:
  database:
    type: postgres
    properties:
      host: db.example.com
      password: "{{ vault('hashi', 'my-app/db-password') }}"
```

## How it works

The provider communicates with the Vault HTTP API. For KV v2 engines it
uses the `/v1/<mount>/data/<key>` and `/v1/<mount>/metadata/<key>` paths;
for KV v1 it uses `/v1/<mount>/<key>` directly. Secrets with a single
`value` field are returned as plain strings; multi-field secrets are
returned as JSON.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
