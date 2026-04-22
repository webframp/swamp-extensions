# @webframp/pass

GPG-encrypted password store vault provider for [swamp](https://github.com/systeminit/swamp), backed by the [pass](https://www.passwordstore.org/) CLI.

## Prerequisites

- [pass](https://www.passwordstore.org/) installed and initialized (`pass init <gpg-id>`)
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
```

With the default `prefix: "swamp"`, a secret named `db/password` is stored as
`swamp/db/password` in the pass store. Set `prefix: ""` to store keys without
a namespace.

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
stored by earlier versions have no prefix. To access them without migration,
set `prefix: ""` in your vault config.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
