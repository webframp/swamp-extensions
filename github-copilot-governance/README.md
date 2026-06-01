# @webframp/github-copilot-governance

Manage GitHub Copilot budgets, monitor AI credit usage, and automate
tier-based governance for Enterprise Cloud organizations.

## Authentication

Requires a classic PAT with enterprise admin or billing manager scope,
stored in a swamp vault. Fine-grained PATs and GitHub App tokens are NOT
supported by the billing API.

```bash
# Store token in vault
swamp vault put my-vault github-enterprise-token "ghp_..."

# Create model with vault reference
swamp model create @webframp/github-copilot-governance copilot-gov \
  --global-arg enterprise=my-enterprise \
  --global-arg org=my-org \
  --global-arg 'token=vault://my-vault/github-enterprise-token'
```

## Methods

### Budget Lifecycle (full CRUD)

| Method | Description |
|--------|-------------|
| `list_budgets` | List all budgets, optionally filtered by scope |
| `get_budget` | Get a specific budget by ID |
| `create_budget` | Create a budget (upsert — returns existing if match found) |
| `update_budget` | Modify budget amount, alerts, enforcement |
| `delete_budget` | Remove a budget (idempotent) |

### Usage Monitoring

| Method | Description |
|--------|-------------|
| `get_usage_summary` | Org-level AI credit usage for current billing period |
| `get_premium_usage` | Per-model premium request breakdown |
| `diff_usage` | Compare current vs previous usage (cycle-aware) |

### Seat & Policy Management

| Method | Description |
|--------|-------------|
| `list_seats` | Copilot seat assignments with last-activity |
| `get_copilot_settings` | Org copilot configuration |
| `get_model_policies` | Enterprise model access policies |

### Tier Automation

| Method | Description |
|--------|-------------|
| `sync_tier_budgets` | Reconcile cost center budgets from team membership × per-user amount |

## Usage Examples

```bash
# List all budgets
swamp model method run copilot-gov list_budgets

# List only cost center budgets
swamp model method run copilot-gov list_budgets --input scope=cost_center

# Create a budget for a cost center
swamp model method run copilot-gov create_budget \
  --input budgetAmount=500 \
  --input budgetScope=cost_center \
  --input entityName=engineering-team \
  --input productSku=copilot \
  --input 'alertRecipients:json=["admin-user"]'

# Sync tier budgets from team membership (dry run first)
swamp model method run copilot-gov sync_tier_budgets \
  --input 'tiers:json=[{"teamSlug":"tier-50","perUserBudget":50,"costCenterName":"dev-standard"}]' \
  --input dryRun=true

# Get usage summary
swamp model method run copilot-gov get_usage_summary

# Compare usage between periods
swamp model method run copilot-gov diff_usage

# List seats to find inactive users
swamp model method run copilot-gov list_seats
```

## Governance Workflow

The recommended operational pattern:

1. **Set budgets** — `create_budget` for enterprise, org, and cost center scopes
2. **Assign tiers** — `sync_tier_budgets` to align cost center budgets with team membership
3. **Monitor** — `get_usage_summary` + `diff_usage` to track spend trends
4. **Review seats** — `list_seats` to identify inactive licenses
5. **Adjust** — `update_budget` to tighten or relax based on data

## API Notes

- Budget endpoints are enterprise-scoped (`/enterprises/{enterprise}/settings/billing/budgets`)
- Usage endpoints are org-scoped (`/organizations/{org}/settings/billing/...`)
- Seat endpoints use legacy path (`/orgs/{org}/copilot/billing/seats`)
- API is in public preview — response schemas may change
- Budget pagination is capped at 10 per page by GitHub

## License

Apache-2.0
