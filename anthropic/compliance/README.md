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

### Directory reads cap at 20,000 items

The directory endpoints (users, roles, groups, group members) page with an
opaque `next_page` token passed back as `page`. The helper reads up to 20 pages
of 1,000 items each, so organizations with more than 20,000 users or group
members get truncated results. The `has_more` field in the output is true
whenever data may remain unread: the cap was reached, or the API reported more
data without a usable `next_page` token. The config-snapshot report marks the
directory user count `truncated` in that case, and adds `rolesTruncated` or
`groupsTruncated` when those lists were cut short.

### `collect_activities` pages on request

By default `collect_activities` fetches one page (up to 5,000 entries, newest
first). Set `max_pages` (1–50) to follow `has_more` through older pages; each
page passes the previous `last_id` as `after_id`. When data remains, the output
carries `next_cursor`: pass it as `after_id` to resume. A cursor is only valid
for the same filters, so the output records them under `filters`. If the API
returns a cursor that does not advance, the method stops instead of looping and
reports `has_more: true` with `stalled: true`, so a truncated feed is never
shown as complete. Timestamps need `Z` or an offset when they include a time;
a date-only value means 00:00Z that day.

`actor_ids` takes directory user IDs (from `sync_users`); a user whose account
was deleted and recreated has a different ID, so look up each ID separately.
`since` and `until` bound the window. `limit` and `max_pages` must be positive
integers. The `recent` resource is overwritten on every run, and a 50-page run
at 5,000 entries per page can hold up to 250,000 records, so prefer filters
over very deep unfiltered walks.

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
