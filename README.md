# Swamp Extensions

Extensions for [swamp](https://github.com/swamp-club/swamp) providing model integrations, workflow+report combos, vault providers, datastore backends, and execution drivers.

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
| [`@webframp/aws/alarm-investigation`](aws/alarm-investigation/) | Triages CloudWatch alarms by enriching them with metric activity, SNS subscriptions, and state-change history, classifying each as healthy, stale, silent, noisy, orphaned, or unknown | `@aws-sdk/client-cloudwatch`, `@aws-sdk/client-sns` |
| [`@webframp/aws/event-topology`](aws/event-topology/) | Discovers and analyzes the event graph across EventBridge, SNS, SQS, and Lambda event source mappings | `@aws-sdk/client-eventbridge`, `@aws-sdk/client-sns`, `@aws-sdk/client-sqs`, `@aws-sdk/client-lambda`, and others |
| [`@webframp/aws/dns-observation`](aws/dns-observation/) | Observes Route53 hosted zones/records and flags orphaned DNS entries pointing at decommissioned infrastructure | `@aws-sdk/client-route-53` |
| [`@webframp/aws/service-quotas`](aws/service-quotas/) | Monitors AWS Service Quotas across accounts via fan-out utilization checks, flagging limits nearing capacity | `@aws-sdk/client-service-quotas`, `@aws-sdk/client-cloudwatch`, and others |
| [`@webframp/aws/iam`](aws/iam/) | Cross-account IAM inventory and trust-graph analysis for privilege-escalation and security review | `@aws-sdk/client-iam`, `@aws-sdk/client-sts` |
| [`@webframp/aws/config-compliance`](aws/config-compliance/) | Reads AWS Config rule compliance evaluations as typed, queryable data (read-only) | `@aws-sdk/client-config-service`, `@aws-sdk/client-sts` |
| [`@webframp/aws/bedrock-usage`](aws/bedrock-usage/) | Monitors AWS Bedrock token usage — input/output counts, per-model breakdowns, invocation rates via multi-account/region fan-out | `@aws-sdk/client-cloudwatch`, `@aws-sdk/credential-providers` |
| [`@webframp/aws/guardduty`](aws/guardduty/) | Queries GuardDuty findings from a delegated administrator account across all member accounts in an AWS Organization | `@aws-sdk/client-guardduty` |
| [`@webframp/aws/adopt`](aws/adopt/) | Discovers existing AWS infrastructure (EC2, RDS, CloudFormation, Secrets Manager) for brownfield adoption into swamp models | `@swamp/aws/ec2`, `@swamp/aws/rds`, `@swamp/aws/secretsmanager` |
| [`@webframp/aws/drift-state`](aws/drift-state/) | Composes drift baselines, results, timelines, and velocity from existing adopt/inventory/terraform/config/dns/event-topology data, making no AWS API calls of its own | `@webframp/aws/adopt`, `@webframp/aws/inventory` |
| [`@webframp/aws/securityhub-findings`](aws/securityhub-findings/) | Queries and manages the lifecycle (triage, archive, resolve, reopen) of AWS Security Hub findings from a delegated admin account | None |
| [`@webframp/terraform`](terraform/) | Terraform/OpenTofu state reader — resource inventory, full state, and outputs | None (shells out to `terraform` or `tofu`) |
| [`@webframp/twitch`](twitch/) | Twitch Moderation — cross-channel moderation visibility, suspicious user detection, ban overlap analysis | None (uses fetch) |
| [`@webframp/ai-usage`](ai-usage/) | Cross-provider AI token usage model aggregating Bedrock, Vertex AI, and Azure OpenAI usage data | `@webframp/aws/bedrock-usage`, `@webframp/gcp/vertex-usage`, `@webframp/azure/openai-usage` |
| [`@webframp/azure/openai-usage`](azure/openai-usage/) | Monitors Azure OpenAI / AI Services token usage across subscriptions via Azure Monitor, with per-deployment breakdowns | None (uses fetch) |
| [`@webframp/gcp/vertex-usage`](gcp/vertex-usage/) | Multi-project GCP Vertex AI token-usage monitor via Cloud Monitoring API, with per-model input/output breakdowns | None (uses fetch) |
| [`@webframp/anthropic/compliance`](anthropic/compliance/) | Syncs a Claude Enterprise account's org directory, effective runtime settings, and 6-year audit activity feed via the Compliance API | None (uses fetch) |
| [`@webframp/anthropic/analytics`](anthropic/analytics/) | Pulls Claude Enterprise seat, adoption, and cost/usage analytics (DAU/WAU/MAU, feature adoption, token cost) via the Enterprise Analytics API | None (uses fetch) |
| [`@webframp/microsoft/teams`](microsoft/teams/) | Read-only Microsoft Teams integration (channels, chats, mentions) via the Graph API using device-code auth | None (uses fetch) |
| [`@webframp/datadog/monitors`](datadog/monitors/) | Datadog Monitors — notification rules, config policies, muting | None (uses fetch) |
| [`@webframp/datadog/incidents`](datadog/incidents/) | Datadog Incidents — attachments and related APIs | None (uses fetch) |
| [`@webframp/datadog/slos`](datadog/slos/) | Datadog SLOs — service level objective reports and status | None (uses fetch) |
| [`@webframp/datadog/metrics`](datadog/metrics/) | Datadog Metrics — timeseries queries, bulk tags, metadata, estimates | None (uses fetch) |
| [`@webframp/datadog/logs`](datadog/logs/) | Datadog Logs — search, aggregation, and submission | None (uses fetch) |
| [`@webframp/datadog/events`](datadog/events/) | Datadog Events — search and submission | None (uses fetch) |
| [`@webframp/datadog/downtimes`](datadog/downtimes/) | Datadog Downtimes — scheduled downtime management | None (uses fetch) |
| [`@webframp/datadog/synthetics`](datadog/synthetics/) | Datadog Synthetics — tests, suites, results, global variables | None (uses fetch) |
| [`@webframp/datadog/on-call`](datadog/on-call/) | Datadog On-Call — schedules, escalation, routing, shifts | None (uses fetch) |
| [`@webframp/datadog/teams`](datadog/teams/) | Datadog Teams — management, memberships, permissions, links | None (uses fetch) |
| [`@webframp/datadog/dora`](datadog/dora/) | Datadog DORA Metrics — deployment, incident, and failure events | None (uses fetch) |
| [`@webframp/datadog/security-rules`](datadog/security-rules/) | Datadog Security Rules — detection rule CRUD | None (uses fetch) |
| [`@webframp/datadog/security-signals`](datadog/security-signals/) | Datadog Security Signals — search, triage, state management | None (uses fetch) |
| [`@webframp/datadog/security-suppressions`](datadog/security-suppressions/) | Datadog Security Suppressions — suppression rule management | None (uses fetch) |
| [`@webframp/snyk/apps`](snyk/apps/) | Snyk Apps — OAuth application management, bots, installations | None (uses fetch) |
| [`@webframp/snyk/assets`](snyk/assets/) | Snyk Assets — asset discovery and classification across the group | None (uses fetch) |
| [`@webframp/snyk/cloud`](snyk/cloud/) | Snyk Cloud — cloud environments, scans, and resource posture management | None (uses fetch) |
| [`@webframp/snyk/collections`](snyk/collections/) | Snyk Collections — project collection groupings and management | None (uses fetch) |
| [`@webframp/snyk/container-images`](snyk/container-images/) | Snyk Container Images — container image scanning and vulnerability data | None (uses fetch) |
| [`@webframp/snyk/groups`](snyk/groups/) | Snyk Groups — group management, orgs, members, and audit | None (uses fetch) |
| [`@webframp/snyk/inventory`](snyk/inventory/) | Snyk Inventory — asset discovery for packages, containers, repos, and cloud resources | None (uses fetch) |
| [`@webframp/snyk/issues`](snyk/issues/) | Snyk Issues — vulnerability issues across projects and groups | None (uses fetch) |
| [`@webframp/snyk/memberships`](snyk/memberships/) | Snyk Memberships — group and org member management | None (uses fetch) |
| [`@webframp/snyk/policies`](snyk/policies/) | Snyk Policies — security policy management and rule configuration | None (uses fetch) |
| [`@webframp/snyk/projects`](snyk/projects/) | Snyk Projects — project listing, attributes, relationships, and target management | None (uses fetch) |
| [`@webframp/snyk/sast`](snyk/sast/) | Snyk SAST — static application security testing results and management | None (uses fetch) |
| [`@webframp/snyk/sbom`](snyk/sbom/) | Snyk SBOM — software bill of materials testing and analysis | None (uses fetch) |
| [`@webframp/snyk/self`](snyk/self/) | Snyk Self — current user context, org listing, and app management | None (uses fetch) |
| [`@webframp/snyk/service-accounts`](snyk/service-accounts/) | Snyk Service Accounts — automated access management for CI/CD | None (uses fetch) |
| [`@webframp/snyk/settings`](snyk/settings/) | Snyk Settings — organization and group setting management | None (uses fetch) |
| [`@webframp/snyk/slack`](snyk/slack/) | Snyk Slack Integration — Slack app configuration and channel management | None (uses fetch) |
| [`@webframp/snyk/sso`](snyk/sso/) | Snyk SSO — single sign-on connection management for groups | None (uses fetch) |
| [`@webframp/snyk/tenants`](snyk/tenants/) | Snyk Tenants — tenant and organization lifecycle management | None (uses fetch) |
| [`@webframp/snyk/tests`](snyk/tests/) | Snyk Tests — on-demand package and dependency vulnerability testing | None (uses fetch) |
| [`@webframp/gitlab-review`](gitlab-review/) | AI-assisted GitLab merge request code review (GraphQL + REST) with a human approval gate and draft/edit/post workflow | None (uses fetch) |
| [`@webframp/reddit/moderation`](reddit/) | Reddit moderation API wrapper — modqueue inspection, reports, mod action logs, and actions (approve, remove, ban, modmail, flair) | None (uses fetch) |
| [`@webframp/discourse`](discourse/) | Queries Discourse forums — categories, topics, and search via the public REST API | None (uses fetch) |
| [`@webframp/artifactory`](artifactory/) | Queries and monitors JFrog Artifactory — AQL package search, repo health checks, and service status with diff detection | None (uses fetch) |
| [`@webframp/research-collector`](research-collector/) | Collects research intelligence from HN, Lobste.rs, SRE Weekly, IFIN Discourse, and RedMonk for daily briefing workflows | None (uses fetch) |
| [`@webframp/hermes-journal-writer`](hermes-journal-writer/) | Reads research-collector data and writes/commits/pushes daily org-mode journal entries to a local org repo | None (shells out to `git`) |
| [`@webframp/hermes-kanban-orchestrator`](hermes-kanban-orchestrator/) | Creates and tracks Kanban tasks as versioned swamp resources via `hermes kanban create`, with idempotency-key deduplication | None |
| [`@webframp/container-image`](container-image/) | Registry-agnostic OCI image build/push/inspect model (docker, podman, nerdctl, buildah; ECR, GHCR, DockerHub) | None (shells out to docker/podman/etc.) |
| [`@webframp/team-topology`](team-topology/) | Agent-guided team topology and value-stream mapping (teams, interactions, ownership, flows) as versioned snapshots | None |
| [`@webframp/threat-model`](threat-model/) | Agent-guided agile threat modeling — scope/identify/evaluate/mitigate/posture stages producing a risk matrix and posture snapshot | None |
| [`@webframp/ddd-guidance`](ddd-guidance/) | Agent-guided Domain-Driven Design facilitator — bounded contexts, ubiquitous language, and aggregate boundaries as versioned domain knowledge | None |
| [`@webframp/rice-scoring`](rice-scoring/) | Agent-guided RICE (Reach, Impact, Confidence, Effort) prioritization framework producing ranked, versioned scorecards | None |
| [`@webframp/swamp-adoption`](swamp-adoption/) | Interactive onboarding model that interviews users to map their domain onto swamp primitives and scaffolds extension designs | None |
| [`@webframp/redmine`](redmine/) | Workflow-agnostic Redmine CRUD model — 26 methods covering issues, projects, statuses, trackers, users, custom fields, relations, time entries, and more | None |

## Workflow + Report Extensions

| Extension | Description | Dependencies |
|-----------|-------------|--------------|
| [`@webframp/sre`](sre/) | SRE health check — runs HTTP, TLS, DNS, and port probes plus system diagnostics, then generates a unified health report | `@webframp/network`, `@webframp/system` |
| [`@webframp/cloudflare-audit`](cloudflare-audit/) | Cloudflare security and configuration audit — inspects zone settings, DNS, WAF, Workers, and cache, then generates a severity-rated report | `@webframp/cloudflare` |
| [`@webframp/aws-ops`](aws/ops/) | AWS incident investigation and daily pulse checks — gathers logs, metrics, alarms, traces, inventory, networking, cost, and GitHub data, then generates incident and morning-pulse reports | `@webframp/aws/logs`, `@webframp/aws/metrics`, `@webframp/aws/alarms`, `@webframp/aws/traces`, `@webframp/aws/inventory`, `@webframp/aws/networking`, `@webframp/aws/alarm-investigation`, `@webframp/aws/cost-explorer`, `@webframp/github` |
| [`@webframp/aws-cost-audit`](aws/cost-audit/) | AWS cost audit — analyzes spend, resource inventory, and networking waste, then generates savings recommendations | `@webframp/aws/cost-explorer`, `@webframp/aws/networking`, `@webframp/aws/inventory` |
| [`@webframp/aws/terraform-drift`](aws/terraform-drift/) | Terraform drift detection — compares TF state against live AWS resources | `@webframp/terraform`, `@webframp/aws/inventory`, `@webframp/aws/networking` |
| [`@webframp/aws/cost-report`](aws/cost-report/) | AWS cost report formatting (standalone report extension) | None |
| [`@webframp/aws/adopt`](aws/adopt/) | Brownfield AWS adoption workflow — discovers resources, generates setup commands, and orchestrates dependency-ordered import, then reports adoption status | `@swamp/aws/ec2`, `@swamp/aws/rds`, `@swamp/aws/secretsmanager` |
| [`@webframp/aws/drift-state`](aws/drift-state/) | Drift-detection workflow — composes baseline/drift state from other AWS model data into timelines and velocity trends | `@webframp/aws/adopt`, `@webframp/aws/inventory` |
| [`@webframp/aws/securityhub-findings`](aws/securityhub-findings/) | Security Hub findings triage workflow — queries findings across an AWS Organization and generates a triage report | None |
| [`@webframp/ai-usage`](ai-usage/) | Cross-provider AI usage workflow — runs Bedrock, Vertex AI, and Azure OpenAI usage models in parallel, then generates a unified report, gracefully handling unconfigured providers | `@webframp/aws/bedrock-usage`, `@webframp/gcp/vertex-usage`, `@webframp/azure/openai-usage` |
| [`@webframp/agentcore-bootstrap`](agentcore-bootstrap/) | One-shot bootstrap workflow — builds/pushes the AgentCore worker image, provisions ECR and a Bedrock AgentCore runtime, and outputs the runtimeArn for driver configuration | `@webframp/container-image`, `@webframp/agentcore` |
| [`@webframp/redmine-kanban`](redmine-kanban/) | Kanban flow-metrics and sprint-summary reports plus a scaffold-story workflow, built on top of `@webframp/redmine` | `@webframp/redmine` |
| [`@webframp/twitch`](twitch/) | Twitch cross-channel moderation audit — gathers chatters, bans, and mod events across channels, then generates a report highlighting ban overlap and suspicious users | None (uses fetch) |

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
| [`@webframp/valkey-datastore`](datastore/valkey/) | Stores swamp runtime data in Valkey/Redis with sorted-set path indexing and SET NX distributed locking; compatible with ElastiCache Serverless and MemoryDB | `ioredis` |
| [`@webframp/postgres-datastore`](datastore/postgres/) | Stores swamp runtime data in PostgreSQL (RDS/Aurora/Aurora Serverless v2) with fencing-token-based distributed locking | `postgres` (npm client) |
| [`@webframp/dynamodb-datastore`](datastore/dynamodb/) | Stores swamp runtime data in AWS DynamoDB (single-table design) with conditional-write distributed locking and chunked blob storage | `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` |

## Driver Extensions

| Extension | Description | Dependencies |
|-----------|-------------|--------------|
| [`@webframp/nix`](driver/nix/) | Nix execution driver — runs model methods inside a Nix shell environment | Requires `nix` |
| [`@webframp/dry-run`](driver/dry-run/) | Dry-run execution driver — logs method calls without executing them | None |
| [`@webframp/agentcore`](driver/agentcore/) | AWS Bedrock AgentCore execution driver — runs model methods in isolated microVM sessions with S3-based coordination | `@aws-sdk/client-bedrock-agentcore`, `@aws-sdk/client-s3` |

## Installation

Extensions are installed automatically when referenced in a swamp repository
(via [auto-resolution](https://github.com/swamp-club/swamp/pull/725)), or
manually with:

```bash
# Model extensions
swamp extension pull @webframp/cloudflare
swamp extension pull @webframp/github
swamp extension pull @webframp/gitlab
swamp extension pull @webframp/system
swamp extension pull @webframp/network
swamp extension pull @webframp/terraform
swamp extension pull @webframp/twitch
swamp extension pull @webframp/redmine
swamp extension pull @webframp/gitlab-review
swamp extension pull @webframp/reddit/moderation
swamp extension pull @webframp/discourse
swamp extension pull @webframp/artifactory
swamp extension pull @webframp/research-collector
swamp extension pull @webframp/hermes-journal-writer
swamp extension pull @webframp/hermes-kanban-orchestrator
swamp extension pull @webframp/container-image
swamp extension pull @webframp/team-topology
swamp extension pull @webframp/threat-model
swamp extension pull @webframp/ddd-guidance
swamp extension pull @webframp/rice-scoring
swamp extension pull @webframp/swamp-adoption

# Workflow + report extensions (auto-pull model dependencies)
swamp extension pull @webframp/sre
swamp extension pull @webframp/cloudflare-audit
swamp extension pull @webframp/aws-ops
swamp extension pull @webframp/aws-cost-audit
swamp extension pull @webframp/aws/terraform-drift
swamp extension pull @webframp/aws/adopt
swamp extension pull @webframp/aws/drift-state
swamp extension pull @webframp/aws/securityhub-findings
swamp extension pull @webframp/ai-usage
swamp extension pull @webframp/agentcore-bootstrap
swamp extension pull @webframp/redmine-kanban

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
swamp extension pull @webframp/aws/alarm-investigation
swamp extension pull @webframp/aws/event-topology
swamp extension pull @webframp/aws/dns-observation
swamp extension pull @webframp/aws/service-quotas
swamp extension pull @webframp/aws/iam
swamp extension pull @webframp/aws/config-compliance
swamp extension pull @webframp/aws/bedrock-usage
swamp extension pull @webframp/aws/guardduty

# Anthropic extensions
swamp extension pull @webframp/anthropic/compliance
swamp extension pull @webframp/anthropic/analytics

# Microsoft extensions
swamp extension pull @webframp/microsoft/teams

# Datadog extensions
swamp extension pull @webframp/datadog/monitors
swamp extension pull @webframp/datadog/incidents
swamp extension pull @webframp/datadog/slos
swamp extension pull @webframp/datadog/metrics
swamp extension pull @webframp/datadog/logs
swamp extension pull @webframp/datadog/events
swamp extension pull @webframp/datadog/downtimes
swamp extension pull @webframp/datadog/synthetics
swamp extension pull @webframp/datadog/on-call
swamp extension pull @webframp/datadog/teams
swamp extension pull @webframp/datadog/dora
swamp extension pull @webframp/datadog/security-rules
swamp extension pull @webframp/datadog/security-signals
swamp extension pull @webframp/datadog/security-suppressions

# Snyk extensions
swamp extension pull @webframp/snyk/apps
swamp extension pull @webframp/snyk/assets
swamp extension pull @webframp/snyk/cloud
swamp extension pull @webframp/snyk/collections
swamp extension pull @webframp/snyk/container-images
swamp extension pull @webframp/snyk/groups
swamp extension pull @webframp/snyk/inventory
swamp extension pull @webframp/snyk/issues
swamp extension pull @webframp/snyk/memberships
swamp extension pull @webframp/snyk/policies
swamp extension pull @webframp/snyk/projects
swamp extension pull @webframp/snyk/sast
swamp extension pull @webframp/snyk/sbom
swamp extension pull @webframp/snyk/self
swamp extension pull @webframp/snyk/service-accounts
swamp extension pull @webframp/snyk/settings
swamp extension pull @webframp/snyk/slack
swamp extension pull @webframp/snyk/sso
swamp extension pull @webframp/snyk/tenants
swamp extension pull @webframp/snyk/tests

# GCP extensions
swamp extension pull @webframp/gcp/vertex-usage

# Azure extensions
swamp extension pull @webframp/azure/openai-usage

# Vault extensions
swamp extension pull @webframp/pass
swamp extension pull @webframp/gopass
swamp extension pull @webframp/hashicorp-vault
swamp extension pull @webframp/macos-keychain

# Datastore extensions
swamp extension pull @webframp/gitlab-datastore
swamp extension pull @webframp/valkey-datastore
swamp extension pull @webframp/postgres-datastore
swamp extension pull @webframp/dynamodb-datastore

# Driver extensions
swamp extension pull @webframp/nix
swamp extension pull @webframp/dry-run
swamp extension pull @webframp/agentcore
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

### Terraform drift detection

```bash
swamp extension pull @webframp/aws/terraform-drift

# Create required model instances
swamp model create @webframp/terraform tf-infra \
  --global-arg workDir=/path/to/terraform/repo
swamp model create @webframp/aws/inventory aws-inventory \
  --global-arg region=us-east-1
swamp model create @webframp/aws/networking aws-networking \
  --global-arg region=us-east-1

# Run drift detection
swamp workflow run @webframp/terraform-drift
```

### Redmine issue tracking

```bash
# @webframp/redmine alone gives you the CRUD model (26 methods).
# Add @webframp/redmine-kanban for flow-metrics/sprint reports and the
# scaffold-story workflow.
swamp extension pull @webframp/redmine
swamp extension pull @webframp/redmine-kanban

swamp model create @webframp/redmine tracker \
  --global-arg host=https://your-redmine.example.org \
  --global-arg apiKey=YOUR_API_KEY \
  --global-arg project=your-project

swamp workflow run @webframp/scaffold-story \
  --input subject="ADDS | LDAP | Implement Geographic Redundancy"
```

### Terraform state reader

```bash
swamp extension pull @webframp/terraform

swamp model create @webframp/terraform tf-infra \
  --global-arg workDir=/path/to/terraform/repo

# List all managed resources
swamp model method run tf-infra list_resources

# Read full state (one swamp resource per TF resource)
swamp model method run tf-infra read_state

# Read outputs
swamp model method run tf-infra get_outputs

# OpenTofu variant
swamp model create @webframp/terraform tf-tofu \
  --global-arg workDir=/path/to/tofu/repo \
  --global-arg binary=tofu
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

## Support and Warranty

These extensions are free and open source, licensed under [Apache 2.0](LICENSE) —
provided **"AS IS," with no warranty of any kind**, express or implied.

Swamp itself is AGPLv3; extensions are covered instead by Swamp's [Extension and
Definition Exception](https://github.com/swamp-club/swamp-extensions/blob/main/COPYING-EXCEPTION),
which is exactly why each extension can carry its own license. Appearing on the
[swamp.club registry](https://swamp.club) isn't a certification — that's true of
every extension there, not just this repo's.

You're responsible for reading the code, testing it against a non-production
environment, and understanding what a method does — especially anything that
writes, deletes, merges, or requests a change — before pointing it at anything
that matters. Infrastructure automation carries operational risk by nature;
nothing here changes that.

Bug reports are welcome. Pull requests are only occasionally accepted — see
[CONTRIBUTING.md](CONTRIBUTING.md) for why and how — but either way, open an
[issue](https://github.com/webframp/swamp-extensions/issues).

## License

Apache-2.0 — see [LICENSE](LICENSE). Each extension also carries its own
`LICENSE.md`, bundled and published independently to the registry.
