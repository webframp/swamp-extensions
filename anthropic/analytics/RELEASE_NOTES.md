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
