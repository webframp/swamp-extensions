# @webframp/operator-briefing

A workflow-scope swamp report that turns a `daily-briefing` workflow run into a
single, consistent operator briefing: a prioritized review queue plus a set of
operational signals, rendered as markdown and as a stable JSON contract.

The briefing used to be synthesized ad hoc by an agent on every run, so
formatting drifted and accuracy signals were easy to drop. This report makes the
briefing a first-class, versioned artifact: observe once (the workflow's model
methods), render many (this report's JSON is the seam for a live HTML view and
for on-demand executive reports).

## What it does

On workflow completion the report:

1. loops `context.stepExecutions`,
2. dispatches each step by `modelType` to a per-source normalizer (registry in
   `_lib/normalizers/registry.ts`),
3. reads that step's data handles via `dataRepository.getContent(...)` and
   JSON-parses them,
4. flattens everything into a `QueueItem[]` and an `OpsSignal[]`,
5. renders a markdown briefing and the JSON contract.

Adding a source is one workflow step + one ~40-line normalizer + one registry
line. The render / tiering / freshness core never changes.

## Sources

| Source                           | Produces                                                    |
| -------------------------------- | ----------------------------------------------------------- |
| `@webframp/gitlab`               | Four-tier review queue (MRs + todos)                        |
| `@webframp/anthropic/analytics`  | Seats (DAU/WAU/MAU), adoption, cost window                  |
| `@webframp/anthropic/compliance` | Effective-settings count, recent activity volume            |
| `@webframp/aws/service-quotas`   | Quota utilization over threshold, pending increase requests |
| `@swamp/typesafe-ai`             | Typed verdicts with compact source evidence and failure status |

### Queue tiers (GitLab)

1. **Waiting on You** — review requests (`reviewing` MRs + `review_requested`
   todos) and `directly_addressed` todos. Drafts are held out with a note; items
   you have already approved are dropped.
2. **Awaiting Your Merge** — assigned MRs **not** authored by you.
3. **Mentions** — `mentioned` todos.
4. **Your Open MRs** — authored MRs, plus assigned-and-authored-by-you folded
   in.

MRs are deduped on `reference`; a review-request todo for an MR already in the
queue is folded into that MR.

## Accuracy and degradation

- **Freshness** is judged from each source's own `fetchedAt`: ops signals are
  stale after 24h, queue items after 7 days.
- `collected: false` on an analytics resource renders "unavailable (fetch
  failed)" and marks the signal degraded — never a zero.
- A non-empty `failedProfiles[]` on an AWS resource marks the signal degraded
  ("N accounts unreachable"); the sentinel `sso-login-required` renders as
  "re-run granted sso login".
- `truncated` anywhere becomes a note.
- Compliance signals report the **presence** of effective settings and recent
  activity (counts), not drift. Baseline-diff drift detection — comparing
  effective settings against a prior-version baseline to flag real changes — is
  a future enhancement (see `TODO(drift)` in
  `_lib/normalizers/anthropic_compliance.ts`).
- **Degrade, never throw.** Unknown modelType / missing normalizer / parse
  failure are skipped and counted; any unexpected error returns a valid
  `{ markdown, json }` with `degraded: true`.

## JSON contract

```jsonc
{
  "generatedAt": "2026-07-12T00:00:00.000Z",
  "tiers": {
    "waitingOnYou": [/* QueueItem */],
    "awaitingMerge": [/* QueueItem */],
    "mentions": [/* QueueItem */],
    "yourOpenMrs": [/* QueueItem */]
  },
  "queue": [/* all QueueItem, each carries .tier */],
  "ops": [/* OpsSignal */],
  "degraded": false,
  "sourceErrors": { "skippedSteps": 0, "parseFailures": 0 },
  "notes": ["..."]
}
```

`degraded` is `true` when a source failed (a skipped step or an unparseable data
handle — see `sourceErrors`), when any ops signal is degraded, or when the outer
catch fired. `sourceErrors` is always present (`0/0` on a clean run).

`QueueItem`:
`{ tier, source, kind, reference, title, who, ageDays, stale, effort?, draft?, actionHint }`

`OpsSignal`:
`{ source, label, severity, detail, fetchedAt, stale, degraded, degradedReason?, truncated? }`

The JSON — not the markdown — is the durable interface. Design downstream
renderers against it.

## Usage

Require the report on the `daily-briefing` workflow; it renders after the run
completes. Read the results:

```bash
swamp data get report-@webframp/operator-briefing --markdown
swamp data get report-@webframp/operator-briefing-json --json
```

The packaged `@webframp/daily-briefing-typesafe` workflow fetches GitLab, then
invokes `triage_batch` on a compact projection. Install it with the package and
run it with the GitLab output data name for the operator, for example
`--input queueDataName=sescriva`. Its triage step is guarded for an empty queue
and `allowFailure: true`, so factual data and the briefing report survive a
TypeSafe outage.

### TypeSafe interpretation and batch triage

Use TypeSafe only after source models have fetched the facts. Pass a compact,
redacted CEL projection to `ask` or `triage_batch`; TypeSafe classifies that
state and never writes to an external system. Every downstream action remains
draft-first and requires human confirmation.

`triage_batch` extends `@swamp/typesafe-ai` with bounded fan-out. It writes one
`triage-batch-<name>` resource containing only `{ id, answers }`, a SHA-256
fingerprint of the compact queue, aggregate usage, and bounded failure
records—never raw MR state or question text. The consumer must compare that
fingerprint with its current compact queue, discards a mismatch or any partial
batch, and otherwise uses the verified scores only to prioritize existing
factual queue items. It never hides an item or takes an external action.

For a typed verdict, define explicit criteria and an action threshold. A
three-level `score` rubric conventionally maps to routine / review-this-week /
act-today; a `noul` probability below the defined threshold is not an action.
If a TypeSafe `ask` step fails, this report emits a degraded
"interpretation unavailable" signal while preserving the underlying factual
signals.

## Troubleshooting

### Report shows "degraded" with skipped sources

The operator briefing degrades per-source: if a normalizer throws (data missing,
shape unrecognized), it increments `skippedSteps` and continues. The JSON
output's `degraded` field is `true` when any source produced errors. Check the
`notes` array in the JSON output for specific failure messages.

### `append_metrics` skips the write and returns empty handles

The method refuses to write if it cannot confidently read the existing series.
Three conditions trigger this: the stored resource throws on read, `rows` is not
an array, or `rows` has entries that all fail parsing. This protects history
from being overwritten by a partial series. Fix the underlying data issue (check
the resource with `swamp data get`) before re-running.

### Dashboard renders without trend data

If `render_dashboard` cannot read the metrics series (missing resource, parse
error), it renders a valid HTML dashboard with empty trend columns. Check that
`append_metrics` has been running successfully to populate the series.

### Sources table in README is incomplete

The extension supports 7 upstream sources (gitlab, anthropic/analytics,
anthropic/compliance, aws/service-quotas, aws/securityhub-findings,
aws/cost-explorer, redmine) but the README documents only 4. Check the manifest
description for the complete list.

### No global args — configuration is implicit

The metrics model defines no global arguments. All configuration happens via
method inputs (`date`, metric fields) and the workflow context (which model
instances are referenced in workflow steps).

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
