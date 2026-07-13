## 2026.07.13.1

**Added:** `@webframp/operator-briefing/review-queue` — a new **method-scope**
report attached to the `@webframp/gitlab` model. It fires after a single
`list_my_merge_requests` execution and renders the four GitLab review tiers
LIVE (waiting on you / awaiting your merge / mentions / your open MRs) — a fast
path between full daily briefings, with no ops section.

It reuses the SAME shared `_lib` the workflow briefing uses — the gitlab
normalizer and a shared `renderQueueSection` in `_lib/render.ts` — so the two
reports render their GitLab tiers through one code path and can never diverge in
tiering, shape, or format. The method report emits the same stable JSON contract
restricted to the queue tiers (`ops: []`), and degrades rather than throwing (an
unreadable handle is counted, a missing dashboard yields a valid empty queue).
The data-handle reader is now shared in `_lib/read.ts` across both reports.

**Changed (both reports benefit):**

- **Long table cells are truncated.** `_lib/render.ts` now caps a free-text cell
  (an MR title or a todo body) to ~80 visible characters with an ellipsis before
  escaping, so a long mention body no longer dumps a wall of text into a table
  cell. The full text is preserved untouched in the JSON contract.
- **Honest degraded-ops phrasing.** When an AWS quota signal is degraded (e.g. a
  non-empty `failedProfiles` from an expired SSO session) and returned no
  entries, its detail now reads "ec2: not checked" instead of the dishonest
  "ec2: all quotas below threshold" — the quotas were never observed. The
  `degradedReason` still carries the actionable hint (re-run `granted sso
  login`). A non-empty result is still reported as the real value it is.

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
