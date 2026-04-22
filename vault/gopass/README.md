# @webframp/gopass

A swamp vault extension that integrates with [gopass](https://gopass.pw), the
pass-compatible password manager with extra features. This extension allows swamp
to retrieve, store, and list secrets managed by gopass, supporting multiple
stores/mounts and optional password-only mode that returns just the first line of
a secret entry.

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
      store: ""            # Optional: mount/store name (omit or leave empty for default store)
      passwordOnly: true   # Return only the first line (password) of the secret
  - name: team-secrets
    type: "@webframp/gopass"
    config:
      store: "team"        # Use the "team" mounted store
      passwordOnly: false  # Return the full secret entry including metadata
```

## Usage

Once configured, use standard `swamp vault` CLI commands to interact with your
gopass secrets:

```bash
# List all secrets in the configured store
swamp vault list --vault default

# Retrieve a secret value
swamp vault get --vault default --key "services/api-token"

# Store a new secret
swamp vault put --vault default --key "services/new-secret" --value "s3cret!"

# Use the team store
swamp vault list --vault team-secrets
swamp vault get --vault team-secrets --key "shared/db-password"
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

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
