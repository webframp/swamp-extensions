# @webframp/terraform

A swamp extension model that reads Terraform and OpenTofu state via the CLI and
marshals it into swamp resources for use in workflows, reports, and CEL
expressions.

The model shells out to `terraform show -json` (or `tofu show -json`) to read
state from any configured backend. It writes swamp resources keyed by Terraform
resource address, making its attributes available for downstream consumption.
Attributes Terraform marks sensitive are masked before anything is written, for
state that records them (Terraform 0.15 and later, and OpenTofu).

## Features

- Read full Terraform or OpenTofu state into swamp resources (sensitive
  attributes are masked when state records them)
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

| Argument    | Default      | Description                                         |
| ----------- | ------------ | --------------------------------------------------- |
| `workDir`   | _(required)_ | Path to an initialized Terraform/OpenTofu directory |
| `workspace` | `default`    | Terraform workspace name                            |
| `binary`    | `terraform`  | CLI binary: `terraform` or `tofu`                   |

## Methods

### `list_resources`

Reads state and writes a single `tf_inventory` resource containing the Terraform
version, total resource count, and a summary array of every managed resource
(address, type, name, provider, module path).

### `read_state`

Reads full state and writes one `tf_resource` per Terraform resource, keyed by
its address. Each resource includes the attribute map from state, with every
attribute Terraform marks sensitive (in the state's `sensitive_values`) replaced
by `***SENSITIVE***`. When a whole map, list or nested block is sensitive (for
example `tags = merge(var.common_tags, { Owner = var.owner })` over a sensitive
variable), the attribute becomes that string rather than a map with masked
values, so consumers must not assume the original shape. Read sensitive values
from the Terraform backend directly when you need them.

Masking depends on `sensitive_values`, which `terraform show -json` emits from
Terraform 0.15 onward and OpenTofu always emits. A resource without it (state
from an older Terraform) is written unmasked, and `read_state` logs a warning
naming each such resource address. Upgrade Terraform before reading state that
holds secrets.

### `get_outputs`

Reads Terraform outputs and writes one `tf_output` per output plus an `all`
summary resource. Sensitive outputs are redacted to `***SENSITIVE***`.

## Troubleshooting

### No timeout on Terraform CLI execution

The extension spawns `terraform show -json` (or other commands) and waits
indefinitely for completion. If the Terraform backend is unreachable (S3 with
network issues, Terraform Cloud downtime), the method hangs. Consider setting
environment-level timeouts externally.

### Empty state is valid, not an error

If `terraform show -json` returns a state with no `root_module`, the methods
produce zero-resource inventories or empty handle arrays. This is the expected
case for uninitialized workspaces — not a failure condition.

### `binary` global arg accepts any string

The schema does not validate that `binary` is `"terraform"` or `"tofu"`. Any
string is passed as the CLI binary name. An incorrect binary name produces a
"command not found" error at runtime, not at validation.

### `workDir` must exist and contain initialized Terraform

The `workDir` global arg is not validated for existence at schema time. If the
directory does not exist or lacks a `.terraform` directory, the CLI throws with
a descriptive error from `terraform` itself.

### Large states write many resources sequentially

`read_state` writes one swamp resource per Terraform resource in a tight loop
with no batching or concurrency. Very large states (thousands of resources) will
take proportionally longer. No `truncated` field exists.

### Workspace selection via `TF_WORKSPACE`

The `workspace` global arg (default `"default"`) sets `TF_WORKSPACE` in the CLI
environment. This does not run `terraform workspace select` — it relies on the
environment variable override.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
