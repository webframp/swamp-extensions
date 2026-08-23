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

| Input             | Default              | Description                           |
| ----------------- | -------------------- | ------------------------------------- |
| `location`        | `eastus`             | Azure region                          |
| `resource_group`  | `swamp-datastore-rg` | Resource group name                   |
| `storage_account` | `swampdatastore`     | Storage account (globally unique)     |
| `container_name`  | `swamp-datastore`    | Blob container name                   |
| `blob_prefix`     | `swamp`              | Namespace prefix within the container |

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

The bootstrap retrieves the storage account's connection string and configures
the datastore with `connectionString` auth mode. For production, consider
switching to `sharedKey` or `servicePrincipal` mode after bootstrapping — see
the `@webframp/azure-blob-datastore` README.

## Idempotency

All resources are checked before creation. Re-running is safe:

- Existing resource groups, storage accounts, and containers are reused
- The connection string is re-retrieved on each run

## Troubleshooting

**`Azure CLI failed: az storage account create ... — StorageAccountAlreadyTaken`**
The `storage_account` global arg has no reserved-name check before creation —
`storageAccountExists` only looks inside your resource group, but storage
account names are globally unique across _all_ Azure tenants. If someone else
already owns the name, `az storage account create` fails and the raw `az` stderr
is surfaced verbatim. Pick a different, more specific `storage_account` value
(3–24 lowercase alphanumeric characters).

**`AuthorizationPermissionMismatch` on container check/create, but the resource
group and storage account were created fine** `containerExists` and
`createContainer` both pass `--auth-mode login`, which authorizes container
operations via Azure AD RBAC (the `Storage Blob Data
Contributor` or
`Storage Blob Data Reader` role on the storage account), separately from the
Azure Resource Manager permissions used to create the resource group and storage
account itself. Being a subscription `Contributor` is not enough — grant
yourself one of those data-plane roles on the storage account (or the resource
group) before re-running.

**Bootstrap looks like it's retrying resource creation on every run**
`resourceGroupExists`, `storageAccountExists`, and `containerExists` decide "not
found" by matching the substring `"not found"` or a specific Azure error code
(`ResourceGroupNotFound`, `ResourceNotFound`, `ContainerNotFound`) in the `az`
CLI's stderr. If `az` isn't actually authenticated (e.g., an expired `az login`
session), the CLI emits an authentication error that doesn't match those
substrings, so it propagates as a raw failure instead of the intended not-found
path — run `az account show` first if resource checks behave unexpectedly.

**`Could not retrieve connection string for storage account <name>`**
`getConnectionString` throws this explicitly when
`az storage account show-connection-string` returns no `connectionString` field
— this happens if the storage account was created with customer-managed key
encryption or has been disabled/locked outside of this bootstrap. Re-run after
confirming the account's state with `az storage account show`.

## Development

```bash
cd azure-blob-datastore-bootstrap
~/.swamp/deno/deno task check
~/.swamp/deno/deno task test
```
