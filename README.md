# Swamp Extensions

Extensions for [swamp](https://github.com/systeminit/swamp) providing model integrations, workflow+report combos, vault providers, datastore backends, and execution drivers.

## Model Extensions

| Extension | Description | Dependencies |
|-----------|-------------|--------------|
| [`@webframp/cloudflare`](cloudflare/) | Cloudflare management — zones, DNS, WAF, Workers, cache | None (uses fetch) |
| [`@webframp/github`](github/) | GitHub operations via the `gh` CLI — repos, PRs, issues, releases, workflows | None (shells out to `gh`) |
| [`@webframp/gitlab`](gitlab/) | GitLab operations via REST API — projects, merge requests, issues, pipelines | None (uses fetch) |
| [`@webframp/system`](system/) | Local system diagnostics — disk usage, memory, uptime/load | None (shells out to OS commands) |
| [`@webframp/network`](network/) | Network probes — HTTP checks, TLS cert inspection, DNS lookup, whois, port scanning | None (shells out to `curl`, `openssl`, `dig`, `whois`) |
| [`@webframp/aws/pricing`](aws/pricing/) | AWS Pricing API for service cost lookups | `@aws-sdk/client-pricing` |
| [`@webframp/aws/inventory`](aws/inventory/) | EC2, RDS, DynamoDB, Lambda, and S3 inventory discovery | `@aws-sdk/client-ec2`, `@aws-sdk/client-rds`, and others |
| [`@webframp/aws/logs`](aws/logs/) | CloudWatch Logs queries and analysis | `@aws-sdk/client-cloudwatch-logs` |
| [`@webframp/aws/metrics`](aws/metrics/) | CloudWatch Metrics retrieval and anomaly analysis | `@aws-sdk/client-cloudwatch` |
| [`@webframp/aws/alarms`](aws/alarms/) | CloudWatch Alarms status, history, and active alerts | `@aws-sdk/client-cloudwatch` |
| [`@webframp/aws/traces`](aws/traces/) | X-Ray distributed tracing and error analysis | `@aws-sdk/client-xray` |
| [`@webframp/aws/cost-estimate`](aws/cost-estimate/) | Cost estimation from inventory specs | `@aws-sdk/client-pricing` |
| [`@webframp/aws/cost-explorer`](aws/cost-explorer/) | AWS Cost Explorer spend analysis by service, usage type, and trend | `@aws-sdk/client-cost-explorer` |
| [`@webframp/aws/networking`](aws/networking/) | VPC networking inspection — NAT Gateways, Load Balancers, Elastic IPs | `@aws-sdk/client-ec2`, `@aws-sdk/client-elastic-load-balancing-v2`, `@aws-sdk/client-cloudwatch` |

## Workflow + Report Extensions

| Extension | Description | Dependencies |
|-----------|-------------|--------------|
| [`@webframp/sre`](sre/) | SRE health check — runs HTTP, TLS, DNS, and port probes plus system diagnostics, then generates a unified health report | `@webframp/network`, `@webframp/system` |
| [`@webframp/cloudflare-audit`](cloudflare-audit/) | Cloudflare security and configuration audit — inspects zone settings, DNS, WAF, Workers, and cache, then generates a severity-rated report | `@webframp/cloudflare` |
| [`@webframp/aws-ops`](aws/ops/) | AWS incident investigation — gathers alarms, metrics, traces, and logs, then generates an incident report | `@webframp/aws/logs`, `@webframp/aws/metrics`, `@webframp/aws/alarms`, `@webframp/aws/traces` |
| [`@webframp/aws-cost-audit`](aws/cost-audit/) | AWS cost audit — analyzes spend, resource inventory, and networking waste, then generates savings recommendations | `@webframp/aws/cost-explorer`, `@webframp/aws/networking`, `@webframp/aws/inventory` |
| [`@webframp/aws/cost-report`](aws/cost-report/) | AWS cost report formatting (standalone report extension) | None |

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

## Driver Extensions

| Extension | Description | Dependencies |
|-----------|-------------|--------------|
| [`@webframp/nix`](driver/nix/) | Nix execution driver — runs model methods inside a Nix shell environment | Requires `nix` |
| [`@webframp/dry-run`](driver/dry-run/) | Dry-run execution driver — logs method calls without executing them | None |

## Installation

Extensions are installed automatically when referenced in a swamp repository
(via [auto-resolution](https://github.com/systeminit/swamp/pull/725)), or
manually with:

```bash
# Model extensions
swamp extension pull @webframp/cloudflare
swamp extension pull @webframp/github
swamp extension pull @webframp/gitlab
swamp extension pull @webframp/system
swamp extension pull @webframp/network

# Workflow + report extensions (auto-pull model dependencies)
swamp extension pull @webframp/sre
swamp extension pull @webframp/cloudflare-audit
swamp extension pull @webframp/aws-ops
swamp extension pull @webframp/aws-cost-audit

# AWS model extensions
swamp extension pull @webframp/aws/pricing
swamp extension pull @webframp/aws/inventory
swamp extension pull @webframp/aws/logs
swamp extension pull @webframp/aws/metrics
swamp extension pull @webframp/aws/alarms
swamp extension pull @webframp/aws/traces
swamp extension pull @webframp/aws/cost-estimate
swamp extension pull @webframp/aws/cost-explorer
swamp extension pull @webframp/aws/networking
swamp extension pull @webframp/aws/cost-report

# Vault extensions
swamp extension pull @webframp/pass
swamp extension pull @webframp/gopass
swamp extension pull @webframp/hashicorp-vault
swamp extension pull @webframp/macos-keychain

# Datastore extensions
swamp extension pull @webframp/gitlab-datastore

# Driver extensions
swamp extension pull @webframp/nix
swamp extension pull @webframp/dry-run
```

## Usage

### SRE health check

```bash
swamp extension pull @webframp/sre

swamp model create @webframp/network net-probe
swamp model create @webframp/system sys-diag

swamp workflow run @webframp/sre-health-check --input target=https://example.com
```

### Cloudflare audit

```bash
swamp extension pull @webframp/cloudflare-audit

swamp model create @webframp/cloudflare/zone cf-zone \
  --global-arg apiToken=CLOUDFLARE_API_TOKEN
swamp model create @webframp/cloudflare/dns cf-dns \
  --global-arg apiToken=CLOUDFLARE_API_TOKEN --global-arg zoneId=ZONE_ID
swamp model create @webframp/cloudflare/waf cf-waf \
  --global-arg apiToken=CLOUDFLARE_API_TOKEN --global-arg zoneId=ZONE_ID
swamp model create @webframp/cloudflare/worker cf-worker \
  --global-arg apiToken=CLOUDFLARE_API_TOKEN --global-arg accountId=ACCOUNT_ID
swamp model create @webframp/cloudflare/cache cf-cache \
  --global-arg apiToken=CLOUDFLARE_API_TOKEN --global-arg zoneId=ZONE_ID

swamp workflow run @webframp/cloudflare-audit --input zoneId=ZONE_ID
```

### AWS incident investigation

```bash
swamp extension pull @webframp/aws-ops

swamp model create @webframp/aws/logs aws-logs --global-arg region=us-east-1
swamp model create @webframp/aws/metrics aws-metrics --global-arg region=us-east-1
swamp model create @webframp/aws/alarms aws-alarms --global-arg region=us-east-1
swamp model create @webframp/aws/traces aws-traces --global-arg region=us-east-1

swamp workflow run @webframp/investigate-outage
```

### AWS cost audit

```bash
swamp extension pull @webframp/aws-cost-audit

swamp model create @webframp/aws/cost-explorer aws-costs --global-arg region=us-east-1
swamp model create @webframp/aws/networking aws-networking --global-arg region=us-east-1
swamp model create @webframp/aws/inventory aws-inventory --global-arg region=us-east-1

swamp workflow run @webframp/cost-audit
```

### Vault extensions

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

```bash
# GitLab Datastore
swamp datastore create @webframp/gitlab-datastore my-store \
  --config '{"projectId":"123","token":"glpat-xxxx"}'
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
