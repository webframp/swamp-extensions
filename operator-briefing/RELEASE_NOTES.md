## 2026.07.13.2

**Enriched the stable JSON contract so downstream renderers get clickable links
and chartable AWS data directly from the contract — no reaching around to raw
data resources.**

- **`QueueItem.url`.** Every queue item now carries an optional deep link — an
  MR's `webUrl` or a todo's `targetUrl` — so a renderer can make the reference
  clickable. This also covers issue-todos that have no derivable `reference` but
  do have a `targetUrl`; they now get a `url` too. Left undefined when the
  source carries no URL — never fabricated.
- **Structured, account-redacted AWS `entries` on the `OpsSignal`.** A
  utilization signal (ec2/vpc/eks) now carries its over-threshold quotas as
  `{ quotaName, utilizationPct, usageValue, value, adjustable }`, and the
  pending signal carries `{ quotaName, serviceCode, desiredValue, status }` per
  request — chartable quota facts without parsing the detail string. The entries
  NEVER include an account identifier (`profile`, `accountId`, `requestId`,
  `caseId`, or any bare account number); CLAUDE.md forbids exposing internal
  account IDs. A degraded fetch that observed nothing leaves `entries` absent
  and keeps the honest "not checked" phrasing unchanged.

Both additions are additive to the JSON contract; the markdown projection is
unchanged.

Hardening from a second adversarial review:

- **Account-number redaction now catches embedded digit runs.** Redaction
  previously masked a profile segment only when it was ENTIRELY digits, so an
  account number embedded in a longer name (`prod-123456789012`) leaked into
  `detail`. It now masks ANY 6+ digit run (`prod-123456789012` -> `prod-****`)
  while leaving the all-digits case as `account ****` and never touching
  legitimate large quota values.
- **Null-safe entry mapping.** The AWS entry mappers now filter to real objects
  before mapping, so a `null` element in a resource's `entries` no longer throws
  (which would have dropped the whole aws-quotas section and marked the report
  degraded); the valid entries still surface.
- **`kind` discriminant on AWS entries.** Each entry now carries
  `kind: "utilization" | "pending"` so a consumer iterating entries without the
  parent signal's label cannot misread a pending row's absent `utilizationPct`
  as `0`.

## 2026.07.13.1

**Added:** `@webframp/operator-briefing/review-queue` — a new **method-scope**
report attached to the `@webframp/gitlab` model. It fires after a single
`list_my_merge_requests` execution and renders the four GitLab review tiers LIVE
(waiting on you / awaiting your merge / mentions / your open MRs) — a fast path
between full daily briefings, with no ops section.

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
  `degradedReason` still carries the actionable hint (re-run
  `granted sso
  login`). A non-empty result is still reported as the real value
  it is.

## 2026.07.12.1

**Added:** `@webframp/operator-briefing` — the initial release of the unified
daily operator briefing report (workflow scope).

The report loops a workflow run's step executions, dispatches each step by
`modelType` to a per-source normalizer via a registry, reads that step's data
handles, and flattens the results into two projections held in a shared `_lib/`:

- a **four-tier review queue** (`QueueItem[]`) — waiting on you / awaiting your
  merge / mentions / your open MRs — from `@webframp/gitlab` dashboard data,
  with the accuracy rules the old `review_dashboard` ignored: dedup on
  `reference`, fold assigned∩authored into your-MRs, and drop items already
  approved by the operator (`approvedByMe` / `myReviewState === "approved"`);
- a set of **ops signals** (`OpsSignal[]`) from `@webframp/anthropic/analytics`
  (seats, adoption, cost — a `collected: false` fetch renders "unavailable", not
  zero), `@webframp/anthropic/compliance` (effective-settings count, recent
  activity), and `@webframp/aws/service-quotas` (per-service quota utilization
  over threshold, pending increases, with `failedProfiles` degradation and the
  `sso-login-required` re-auth hint).

Freshness is judged from each source's own `fetchedAt` (stale > 24h for ops,

> 7d for queue items) and `truncated` becomes a note. The report **degrades,
> never throws**: unknown modelType / missing normalizer / parse failure are
> skipped and counted, and any unexpected error returns a valid
> `{ markdown, json }` with `degraded: true`.

Output is a consistent markdown briefing plus a **stable JSON contract**
(`{ generatedAt, tiers, queue, ops, degraded, notes }`) designed as the durable
interface downstream renderers consume.
