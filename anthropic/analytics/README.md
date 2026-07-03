# @webframp/anthropic/analytics

Observe Claude Enterprise analytics: seats, activity, and adoption.

## What it does

Collects enterprise analytics and extracts structured data into versioned
resources:

- **Seats** — total, active, pending invites, DAU/WAU/MAU
- **Adoption** — projects, skills, connectors in use
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

# Collect
swamp model method run claude-analytics collect_analytics
```

## CEL query examples

```bash
# Current seat count
swamp data query claude-analytics \
  'data.latest("claude-analytics","seats").attributes'

# DAU trend (compare versions)
swamp data list claude-analytics seats
```
