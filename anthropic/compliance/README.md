# @webframp/anthropic/compliance

Observe a Claude Enterprise account via the Compliance API.

## What it does

Captures versioned snapshots of:

- **Activity feed** — 6-year audit trail with filtering by activity type, actor,
  and time range (1-minute latency, 600 req/min shared budget)
- **Directory** — users, roles, groups with SCIM source attribution (`direct` vs
  `scim`)
- **Effective settings** — runtime configuration: data retention, content
  redaction, IP allowlist, SSO provisioning mode, code execution egress

## Authentication

Requires a **Compliance Access Key** (`sk-ant-api01-...`) created by the primary
owner in claude.ai → Org settings → API access.

## Quick start

```bash
swamp extension pull @webframp/anthropic/compliance

# Store key in vault
swamp vault put anthropic COMPLIANCE_KEY

# Create model
swamp model create @webframp/anthropic/compliance claude-compliance \
  --global-arg 'complianceKey=${{ vault.get("anthropic", "COMPLIANCE_KEY") }}'

# Observe
swamp model method run claude-compliance sync_organizations
swamp model method run claude-compliance sync_directory
swamp model method run claude-compliance sync_effective_settings
swamp model method run claude-compliance collect_activities
```

## CEL query examples

```bash
# Users without SCIM source
swamp data query claude-compliance \
  'data.latest("claude-compliance","users").attributes.users.filter(u, u.role == "user")'

# Effective settings snapshot
swamp data query claude-compliance \
  'data.latest("claude-compliance","effectiveSettings").attributes.settings'
```
