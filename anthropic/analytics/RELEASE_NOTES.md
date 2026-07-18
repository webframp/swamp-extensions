## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `analytics.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.

## 2026.07.14.1

**Added:** `collect_user_usage` — per-user token usage and cost, so you can see
who is spending what (and how much of it is Claude Code) rather than only the
org aggregate.

- Reads the Enterprise Analytics `/v1/organizations/analytics/user_usage_report`
  (tokens: total / output / uncached-input / cache-read, plus requests) and
  `/user_cost_report` (`amount` and `list_amount`, USD minor units → USD),
  grouped by `product` so `claude_code` is broken out from chat/cowork/etc.
- Optional `email` filter keeps just one user (matched on `actor.email`);
  `products` filters the surfaces; `startDate`/`endDate` bound the window
  (defaults to the last 30 days; the API caps a window at 31 days).
- Writes a `userUsage` resource (instance = the sanitized email, or `all`) with
  a per-user `byProduct` breakdown plus `totalTokens`/`totalCostUsd`. Reuses the
  same `x-api-key` (`read:analytics`) auth and cursor pagination as
  `collect_analytics`. The two reports are collected **independently**: if only
  `user_cost_report` fails (common on seat-based plans, where it 403s while the
  usage report still serves tokens), the token data is retained with
  `collected: true` and `costUsd` left null — `collected: false` only when both
  fail. A single `email`-filtered result is keyed by the user's unique id
  (`user-<userId>`) so emails that sanitize alike cannot collide.

  Caveats: with no `email` filter the resource stores email + name for every
  org user (admin-only PII — mind shared datastores); and very large orgs can
  page-truncate (the filter is applied after fetch), so prefer a date-bounded,
  filtered query for a single user.

Additive: `collect_analytics` and its snapshot/seats/adoption/cost resources are
unchanged.

## 2026.07.07.1

**Fixed:**

- `collect_analytics` called a non-existent endpoint (`/v1/organizations/analytics`,
  HTTP 404) with the wrong param names (`start_date`/`end_date`) and a flat-metrics
  response shape that never matched the real API. Rewritten against the documented
  Enterprise Analytics API: `/analytics/summaries` (seats + DAU/WAU/MAU + pending
  invites, `starting_date`/`ending_date`), `/analytics/users` (paginated, aggregated
  into adopter counts), and `/analytics/cost_report` (paginated, summed by cost type).

**Added:**

- `cost` resource — token cost/usage over the window (usage-based Enterprise plans).
- Adoption and cost collection are best-effort: a failure in `/users` or
  `/cost_report` no longer fails the whole run (seat-based plans have no cost data).

**Changed:**

- `adoption` now reports adopter counts (users with ≥1 project/skill/connector),
  aggregated from `/analytics/users` — there is no org-level adoption endpoint.
- The `snapshot` resource writes to the `recent` instance (`latest` is reserved
  by swamp). Query via `data.latest("claude-analytics", "recent")`.

## 2026.07.02.1

**Added:** Initial release. Enterprise Analytics observation model.
Collects raw metrics snapshot and extracts structured seat counts
(total, active, pending, DAU/WAU/MAU) and adoption metrics (projects,
skills, connectors) into separate versioned resources.
