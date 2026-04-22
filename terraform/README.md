# @webframp/terraform

A swamp extension model that reads Terraform and OpenTofu state via the CLI and
marshals it into swamp resources for use in workflows, reports, and CEL
expressions.

The model shells out to `terraform show -json` (or `tofu show -json`) to read
state from any configured backend. It writes swamp resources keyed by Terraform
resource address, making every attribute available for downstream consumption.

## Features

- Read full Terraform or OpenTofu state into swamp resources
- List all managed resources with type, provider, and module path
- Extract outputs (sensitive values are automatically redacted)
- Workspace selection via global arguments
- Supports both `terraform` and `tofu` binaries

## Installation

```bash
swamp extension pull @webframp/terraform
```

## Quick Start

Create a model instance pointing at an initialized Terraform working directory:

```bash
swamp model create @webframp/terraform tf-infra \
  --global-arg workDir=/path/to/terraform/repo

# List all managed resources
swamp model method run tf-infra list_resources

# Read full state into swamp resources
swamp model method run tf-infra read_state

# Extract outputs
swamp model method run tf-infra get_outputs
```

## Global Arguments

| Argument    | Default       | Description                                       |
|-------------|---------------|---------------------------------------------------|
| `workDir`   | *(required)*  | Path to an initialized Terraform/OpenTofu directory |
| `workspace` | `default`     | Terraform workspace name                          |
| `binary`    | `terraform`   | CLI binary: `terraform` or `tofu`                 |

## Methods

### `list_resources`

Reads state and writes a single `tf_inventory` resource containing the
Terraform version, total resource count, and a summary array of every managed
resource (address, type, name, provider, module path).

### `read_state`

Reads full state and writes one `tf_resource` per Terraform resource, keyed by
its address. Each resource includes the complete attribute map from state.

### `get_outputs`

Reads Terraform outputs and writes one `tf_output` per output plus an `all`
summary resource. Sensitive outputs are redacted to `***SENSITIVE***`.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
