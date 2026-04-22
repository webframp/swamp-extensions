# @webframp/macos-keychain

A swamp vault provider that stores and retrieves secrets using the macOS Keychain via the `security` command-line tool. Secrets are persisted as generic password items, scoped by a configurable service name, and protected by the operating system's native credential storage.

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
      service: "swamp"   # optional, defaults to "swamp"
```

The `service` field controls the Keychain service name under which all secrets are stored. If you omit it, the provider defaults to `"swamp"`.

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

Reference vault secrets in model definitions using the `vault://` expression syntax:

```yaml
globalArgs:
  apiToken:
    type: string
    default: "vault://keychain/my-api-key"
```

When a method runs, swamp resolves `vault://keychain/my-api-key` by calling the provider's `get("my-api-key")` method automatically.

## Supported Platforms

This extension runs only on macOS:

- `darwin-x86_64`
- `darwin-aarch64`

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
