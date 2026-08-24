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

## Troubleshooting

### 600 req/min shared rate limit with no backoff

The Anthropic Compliance API has a 600 requests/minute budget shared across all
consumers. This extension has no rate-limit detection or retry logic. A 429
response throws like any other non-2xx error. Space out invocations of
`sync_directory` (which makes 3+ API calls internally) to stay within budget.

### `paginateAll` caps at 20,000 items

The paginated helper fetches up to 20 pages of 1,000 items each. Organizations
with more than 20,000 users or group members will receive truncated results. The
`hasMore` field in the output is honest when this cap is reached.

### `collect_activities` does not paginate

The activities method fetches a single page (up to 5,000 entries). The
`has_more` field indicates whether more data exists, but follow-up pagination is
the caller's responsibility (adjust `since` for the next window).

### Group name resolution is best-effort

In `get_group_members`, if the API call to resolve the group's display name
fails, the method continues using the raw `groupId` as the name. The failure is
logged at `info` level.

### `orgId` auto-discovery takes the first organization

When `orgId` is omitted from global args, the extension queries
`/v1/compliance/organizations` and uses the first result's `uuid` (or `id`).
Multi-org accounts must set `orgId` explicitly.

### No retry on any API failure

All non-2xx HTTP responses throw immediately. Transient network errors, 5xx from
Anthropic, or brief outages will crash the method invocation without retry.
