## 2026.07.13.5

**Fixed:** The daily briefing falsely reported `degraded: true` whenever the
`metrics_append` step ran in the `daily-briefing` workflow.

The workflow-scope report loops every step execution and dispatches by
`modelType`. The durable metrics accumulator
(`@webframp/operator-briefing/metrics`) runs as a step but is not a briefing
*source* — it has no normalizer by design — so it was skipped-and-counted like
an unknown source, which set `sourceErrors.skippedSteps` and flipped the whole
briefing to `degraded: true` with a spurious "No normalizer …" note.

The report now recognizes a set of **non-source model types**
(`nonSourceModelTypes` in the normalizer registry; today just the metrics
accumulator) and skips them **silently** — no skipped-source count, no note, no
degraded flag. A missing normalizer for any *other* modelType is still a real
gap and is skipped-and-counted as before.

## 2026.07.13.4

**Added a dashboard renderer to the metrics model — the metrics series (and,
optionally, the daily briefing) becomes a self-contained HTML page. Observe
once, render many.**

- **New `render_dashboard` method (`@webframp/operator-briefing/metrics`).**
  Reads the model's own append-only `series` (trend history) and takes an
  optional `report` argument — the operator-briefing JSON contract (review
  queue + ops signals), wired in by the workflow; it is never cross-read from
  storage. Renders ONE self-contained HTML document — inline SVG sparklines,
  stat tiles, tier counts, and an ops table, theme-aware, with no external
  JS/CDN (CSP-safe; renders in a browser or a claude.ai Artifact). Reads only
  its own data, never fetches, and degrades rather than throwing (empty series →
  trends-empty page; a malformed or `null`-bearing report is filtered, not
  fatal).
- **New `dashboard` file resource** (`text/html`, lifetime `30d`,
  `garbageCollection` 10). A regenerated downstream projection, so short
  retention is right. Written via `createFileWriter().writeText()`.
- **`redact: true` shareable mode.** Produces a variant that shows only
  aggregate tier counts, ops severities/labels, and non-identifying numeric
  trends — every reference, author, title, ops `detail`, and `degradedReason` is
  stripped, so no internal URL, username, or account name reaches the page
  (CLAUDE.md forbids exposing internal identifiers). The default
  (`redact: false`) is the operator-local full-detail view.

Additive: `append_metrics`, the `series` resource, and the existing reports and
JSON contract are all unchanged.

## 2026.07.13.3

**Added a durable time-series accumulator — the package's first model — so
trends (spend, DAU burndown, adoption growth) survive version garbage
collection.**

- **New `metrics` model (`@webframp/operator-briefing/metrics`).** Point-in-time
  briefing data is always re-observable, so GC-ing its snapshots is harmless. A
  time series is not: once a versioned snapshot is GC'd, that historical point
  is gone forever. So the series is stored as first-class data in a single
  append-only `series` resource whose LATEST version holds the entire history
  (an array of dated rows). Version-GC then only drops old _partial_ states; the
  latest always has everything, so keeping a handful of versions is safe.
- **`append_metrics` method.** Upserts one day's metrics onto the series by
  date. It reads the latest series, MERGES fields for a shared date (a run that
  carries only spend never wipes that day's dau), sorts ascending by date, and
  writes the whole series back under the stable name "metrics" so it versions in
  place. A one-time `backfill` array seeds prior dates (incoming wins on a
  shared date, still field-merged).
- **Never throws, and never clobbers.** The cardinal rule of an append-only
  accumulator is that a shorter series must never overwrite a longer one. So a
  write happens only when the prior history is KNOWN: a genuinely absent (null)
  series is treated as empty and written fresh, but a prior series that can't be
  READ (a thrown read — transient I/O, not proof of absence) or is MALFORMED
  (`rows` not an array, or a non-empty array with zero parseable rows) SKIPS the
  write rather than truncate real history. A degrade AFTER the read — a failing
  `writeResource` as the payload grows, a throwing logger — likewise leaves the
  stored series untouched (no fallback empty write). A wrong-shaped or
  non-finite metric is skipped rather than fatal, and a metric value of `0` is
  preserved as real data (0 is a number, not "absent"). Dates are validated as
  zero-padded `YYYY-MM-DD`, which also guarantees the lexicographic sort is
  chronological.

Additive: the existing reports and the stable JSON contract are unchanged.

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
