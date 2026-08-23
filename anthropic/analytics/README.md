# @webframp/anthropic/analytics

Observe Claude Enterprise analytics: seats, activity, adoption, and
per-user token cost.

## What it does

Collects enterprise analytics and extracts structured data into versioned
resources:

- **Seats** — total, active, pending invites, DAU/WAU/MAU
- **Adoption** — projects, skills, connectors in use
- **Cost** — token usage cost over a window, broken down by cost type
- **User usage** — per-user token usage and cost, broken down by product
  (Claude Code broken out separately)
- **Raw snapshot** — all metrics as returned by the API

## Authentication

Requires an **Analytics API key** (scope `read:analytics`) created by the
primary owner in claude.ai.

## Quick start

```bash
swamp extension pull @webframp/anthropic/analytics

# Store key in vault
swamp vault put anthropic ANALYTICS_KEY

# Create model
swamp model create @webframp/anthropic/analytics claude-analytics \
  --global-arg 'analyticsKey=${{ vault.get("anthropic", "ANALYTICS_KEY") }}'

# Collect org-wide seats, adoption, and cost
swamp model method run claude-analytics collect_analytics

# Collect per-user usage/cost for the last 30 days
swamp model method run claude-analytics collect_user_usage

# Or scope to one user, one product, and a custom window
swamp model method run claude-analytics collect_user_usage \
  --input '{"email": "user@example.com", "products": ["claude_code"], "days": 7}'
```

## Enterprise volume discount

Set `discountRate` (0–1) as a global arg to apply an enterprise volume
discount to cost totals derived from the API's list-price `amount` fields.
`listCostUsd` fields are always list price and are never adjusted, so you
can compare discounted vs. list cost side by side.

## CEL query examples

```bash
# Current seat count
swamp data query claude-analytics \
  'data.latest("claude-analytics","seats").attributes'

# DAU trend (compare versions)
swamp data list claude-analytics seats

# Whether the last cost collection actually succeeded
swamp data query claude-analytics \
  'data.latest("claude-analytics","cost").attributes.collected'

# Top spender from the last per-user usage collection
swamp data query claude-analytics \
  'data.latest("claude-analytics","userUsage").attributes.users[0]'
```

## Troubleshooting

**`collect_analytics` fails outright with a 401 or 403.**
The activity-summary fetch (`/analytics/summaries`) is the one call that
isn't best-effort — if the key is invalid, expired, or lacks the
`read:analytics` scope, the whole method throws. Adoption and cost are
collected separately after this succeeds.

**`adoption` or `cost` resources show `collected: false`.**
Both are collected best-effort and degrade instead of failing the whole
run. Check the model's logs for the underlying error (logged as
`adoption collection failed` / `cost collection failed`). Common causes:
the key's scope doesn't cover the `/analytics/users` or
`/analytics/cost_report` endpoints, or — for `cost` specifically — the
org is on a seat-based plan rather than usage-based, in which case the
endpoint legitimately has nothing to report and `collected: false` is
expected, not a bug.

**`collect_user_usage` writes a resource with `collected: false` and a
populated `error` field.** `user_usage_report` (tokens) and
`user_cost_report` (cost) are fetched independently — a seat-based plan
commonly serves tokens but 403s on cost. `collected` is true if *either*
report succeeded, so check `error` for which one failed and why before
assuming the whole thing is broken.

**Date range errors ("is not a valid YYYY-MM-DD date" or "must be after
startDate").** `startDate`/`endDate` (or the derived range from `days`)
are validated locally before any request is made. The Analytics API
itself has no data before 2026-01-01 — a validly formatted date earlier
than that will pass local validation but return an empty or erroring
response from the API.

**`collect_user_usage --input '{"email": "..."}'` returns zero users.**
The email filter matches `actor.email` case-insensitively after the
report is fetched — it isn't a server-side query parameter. If the user
made no requests in the window, or their account has no email on record
in the Analytics API's response, the filter has nothing to match.

**Numbers in `seats` look stale or missing.**
`seats` is derived from the summary row with the latest `starting_at` in
the fetched window, not from a separate "current" endpoint. If the
Analytics API hasn't refreshed for the current day yet, the seat counts
reflect the most recent day it has data for — check
`dataRefreshedAt` on the `snapshot` resource.
