## 2026.07.12.1

**Added:** `@webframp/operator-briefing` — the initial release of the unified
daily operator briefing report (workflow scope).

The report loops a workflow run's step executions, dispatches each step by
`modelType` to a per-source normalizer via a registry, reads that step's data
handles, and flattens the results into two projections held in a shared
`_lib/`:

- a **four-tier review queue** (`QueueItem[]`) — waiting on you / awaiting your
  merge / mentions / your open MRs — from `@webframp/gitlab` dashboard data,
  with the accuracy rules the old `review_dashboard` ignored: dedup on
  `reference`, fold assigned∩authored into your-MRs, and drop items already
  approved by the operator (`approvedByMe` / `myReviewState === "approved"`);
- a set of **ops signals** (`OpsSignal[]`) from `@webframp/anthropic/analytics`
  (seats, adoption, cost — a `collected: false` fetch renders "unavailable",
  not zero), `@webframp/anthropic/compliance` (effective-settings count, recent
  activity), and `@webframp/aws/service-quotas` (per-service quota utilization
  over threshold, pending increases, with `failedProfiles` degradation and the
  `sso-login-required` re-auth hint).

Freshness is judged from each source's own `fetchedAt` (stale > 24h for ops,
> 7d for queue items) and `truncated` becomes a note. The report **degrades,
never throws**: unknown modelType / missing normalizer / parse failure are
skipped and counted, and any unexpected error returns a valid `{ markdown, json }`
with `degraded: true`.

Output is a consistent markdown briefing plus a **stable JSON contract**
(`{ generatedAt, tiers, queue, ops, degraded, notes }`) designed as the durable
interface downstream renderers consume.
