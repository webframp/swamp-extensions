# @webframp/azure-blob-datastore-bootstrap

One-shot bootstrap for `@webframp/azure-blob-datastore`. Creates an Azure
Storage account with a blob container, then configures the current swamp
repository to use Azure Blob Storage as the datastore backend.

## Prerequisites

- Azure CLI (`az`) installed and authenticated (`az login`)
- An Azure subscription
- Permissions to create resource groups, storage accounts, and containers

## Usage

```bash
swamp extension pull @webframp/azure-blob-datastore-bootstrap

swamp model create @webframp/azure-blob-datastore-bootstrap/provisioner \
  swamp-azure-blob-provisioner
swamp model create command/shell swamp-azure-blob-setup

swamp workflow run @webframp/bootstrap-azure-blob-datastore \
  --input location=eastus \
  --input storage_account=myswampstore

swamp datastore status
```

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `location` | `eastus` | Azure region |
| `resource_group` | `swamp-datastore-rg` | Resource group name |
| `storage_account` | `swampdatastore` | Storage account (globally unique) |
| `container_name` | `swamp-datastore` | Blob container name |
| `blob_prefix` | `swamp` | Namespace prefix within the container |

**Important**: Storage account names are globally unique across all of Azure.
You'll likely need to override `storage_account` with something unique to you.

## What gets created

### Resource Group

- Tagged with `ManagedBy=swamp`
- Created only if it doesn't exist

### Storage Account

- **Kind:** StorageV2
- **SKU:** Standard_LRS (locally redundant)
- **Public access:** disabled
- **TLS:** 1.2 minimum
- Tagged with `ManagedBy=swamp`

### Blob Container

- Private access level (no anonymous reads)
- Created within the storage account

## Authentication

The bootstrap retrieves the storage account's connection string and
configures the datastore with `connectionString` auth mode. For production,
consider switching to `sharedKey` or `servicePrincipal` mode after
bootstrapping — see the `@webframp/azure-blob-datastore` README.

## Idempotency

All resources are checked before creation. Re-running is safe:
- Existing resource groups, storage accounts, and containers are reused
- The connection string is re-retrieved on each run

## Development

```bash
cd azure-blob-datastore-bootstrap
~/.swamp/deno/deno task check
~/.swamp/deno/deno task test
```
