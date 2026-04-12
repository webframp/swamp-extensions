# Swamp Extensions

Extensions for [swamp](https://github.com/systeminit/swamp) providing vault integrations, datastore backends, AWS operations, and Cloudflare management.

## Vault Extensions

| Extension | Description | Dependencies |
|-----------|-------------|--------------|
| [`@webframp/pass`](vault/pass/) | [pass](https://www.passwordstore.org/) (the standard Unix password manager) vault provider | None (shells out to `pass`) |
| [`@webframp/gopass`](vault/gopass/) | [gopass](https://www.gopass.pw/) vault provider | None (shells out to `gopass`) |
| [`@webframp/hashicorp-vault`](vault/hashicorp-vault/) | HashiCorp Vault provider via REST API (KV v1 and v2) | None (uses fetch) |
| [`@webframp/macos-keychain`](vault/macos-keychain/) | macOS Keychain vault using the `security` CLI | None (shells out to `security`) |

## Datastore Extensions

| Extension | Description | Dependencies |
|-----------|-------------|--------------|
| [`@webframp/gitlab-datastore`](datastore/gitlab-datastore/) | Stores swamp runtime data in GitLab using the Terraform state HTTP API. Provides distributed locking and bidirectional sync. | None (uses fetch) |

## AWS Extensions

| Extension | Description | Dependencies |
|-----------|-------------|--------------|
| [`@webframp/aws/pricing`](aws/pricing/) | AWS Pricing API for service cost lookups | `@aws-sdk/client-pricing` |
| [`@webframp/aws/inventory`](aws/inventory/) | EC2 and RDS inventory discovery | `@aws-sdk/client-ec2`, `@aws-sdk/client-rds` |
| [`@webframp/aws/logs`](aws/logs/) | CloudWatch Logs queries and analysis | `@aws-sdk/client-cloudwatch-logs` |
| [`@webframp/aws/metrics`](aws/metrics/) | CloudWatch Metrics retrieval and analysis | `@aws-sdk/client-cloudwatch` |
| [`@webframp/aws/alarms`](aws/alarms/) | CloudWatch Alarms status and history | `@aws-sdk/client-cloudwatch` |
| [`@webframp/aws/traces`](aws/traces/) | X-Ray distributed tracing | `@aws-sdk/client-xray` |
| [`@webframp/aws/cost-estimate`](aws/cost-estimate/) | Cost estimation from inventory specs | `@aws-sdk/client-pricing` |
| [`@webframp/aws/cost-report`](aws/cost-report/) | Cost report formatting (report extension) | None |
| [`@webframp/aws-ops`](aws/ops/) | Incident investigation workflow with report | None |

## Cloudflare Extensions

| Extension | Description | Dependencies |
|-----------|-------------|--------------|
| [`@webframp/cloudflare`](cloudflare/) | Cloudflare management - zones, DNS, WAF, Workers, cache | None (uses fetch) |

## Installation

Extensions are installed automatically when referenced in a swamp repository
(via [auto-resolution](https://github.com/systeminit/swamp/pull/725)), or
manually with:

```bash
# Vault extensions
swamp extension pull @webframp/pass
swamp extension pull @webframp/gopass
swamp extension pull @webframp/hashicorp-vault
swamp extension pull @webframp/macos-keychain

# Datastore extensions
swamp extension pull @webframp/gitlab-datastore

# AWS extensions
swamp extension pull @webframp/aws/pricing
swamp extension pull @webframp/aws/inventory
swamp extension pull @webframp/aws/logs
swamp extension pull @webframp/aws/metrics
swamp extension pull @webframp/aws/alarms
swamp extension pull @webframp/aws/traces
swamp extension pull @webframp/aws/cost-estimate
swamp extension pull @webframp/aws/cost-report
swamp extension pull @webframp/aws-ops

# Cloudflare extension
swamp extension pull @webframp/cloudflare
```

## Usage

### Vault extensions

Create a vault using an extension type:

```bash
# pass
swamp vault create @webframp/pass my-vault --config '{"store":"default"}'

# gopass
swamp vault create @webframp/gopass my-vault --config '{"store":"default"}'

# HashiCorp Vault
swamp vault create @webframp/hashicorp-vault my-vault --config '{"address":"https://vault.example.com"}'

# macOS Keychain
swamp vault create @webframp/macos-keychain my-vault --config '{"service":"swamp"}'
```

### Datastore extensions

Configure a datastore backend for remote state storage:

```bash
# GitLab Datastore
swamp datastore create @webframp/gitlab-datastore my-store \
  --config '{"projectId":"123","token":"glpat-xxxx"}'

# With custom GitLab instance
swamp datastore create @webframp/gitlab-datastore my-store \
  --config '{"projectId":"mygroup/myproject","token":"glpat-xxxx","baseUrl":"https://gitlab.example.com"}'
```

### AWS extensions

Create model instances for AWS operations:

```bash
# Create model instances for your region
swamp model create @webframp/aws/logs aws-logs --global-arg region=us-east-1
swamp model create @webframp/aws/metrics aws-metrics --global-arg region=us-east-1
swamp model create @webframp/aws/alarms aws-alarms --global-arg region=us-east-1
swamp model create @webframp/aws/traces aws-traces --global-arg region=us-east-1

# Run the investigate-outage workflow
swamp workflow run @webframp/investigate-outage
```

### Cloudflare extension

Create model instances for Cloudflare management:

```bash
# Create a worker model instance
swamp model create @webframp/cloudflare/worker my-worker \
  --global-arg accountId=your-account-id \
  --global-arg apiToken='${{ vault.get(cf-vault, api-token) }}'

# List workers
swamp model method run my-worker list_scripts
```

## Development

Each extension is a standalone swamp repository with its own manifest. All npm
dependencies are pinned to exact versions for reproducible builds.

```bash
# Model extension example
cd aws/logs
deno check extensions/models/aws/logs.ts
deno lint extensions/models/
deno fmt extensions/models/

# Vault extension example
cd vault/pass
deno check extensions/vaults/pass/mod.ts
deno lint extensions/vaults/
deno fmt extensions/vaults/

# Report extension example
cd aws/cost-report
deno check extensions/reports/cost_report.ts
deno lint extensions/reports/
deno fmt extensions/reports/

# Datastore extension example
cd datastore/gitlab-datastore
deno check extensions/datastores/gitlab_datastore/mod.ts
deno lint extensions/
deno fmt extensions/
deno test --allow-net --allow-env --allow-read --allow-write --allow-sys extensions/
```

## Publishing

Extensions are published automatically via GitHub Actions when changes are
pushed to `main`. Each directory containing a `manifest.yaml` is detected
and published to the [swamp.club registry](https://swamp.club).

Manual publishing:

```bash
cd datastore/gitlab-datastore  # or any extension directory
swamp extension push manifest.yaml
```

## License

Apache-2.0
