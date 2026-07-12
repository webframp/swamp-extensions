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

| Source                          | Produces                                                     |
| ------------------------------- | ------------------------------------------------------------ |
| `@webframp/gitlab`              | Four-tier review queue (MRs + todos)                         |
| `@webframp/anthropic/analytics` | Seats (DAU/WAU/MAU), adoption, cost window                   |
| `@webframp/anthropic/compliance`| Effective-settings count, recent activity volume            |
| `@webframp/aws/service-quotas`  | Quota utilization over threshold, pending increase requests  |

### Queue tiers (GitLab)

1. **Waiting on You** — review requests (`reviewing` MRs + `review_requested`
   todos) and `directly_addressed` todos. Drafts are held out with a note;
   items you have already approved are dropped.
2. **Awaiting Your Merge** — assigned MRs **not** authored by you.
3. **Mentions** — `mentioned` todos.
4. **Your Open MRs** — authored MRs, plus assigned-and-authored-by-you folded in.

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
    "mentions":      [/* QueueItem */],
    "yourOpenMrs":   [/* QueueItem */]
  },
  "queue": [/* all QueueItem, each carries .tier */],
  "ops":   [/* OpsSignal */],
  "degraded": false,
  "sourceErrors": { "skippedSteps": 0, "parseFailures": 0 },
  "notes": ["..."]
}
```

`degraded` is `true` when a source failed (a skipped step or an unparseable
data handle — see `sourceErrors`), when any ops signal is degraded, or when the
outer catch fired. `sourceErrors` is always present (`0/0` on a clean run).

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

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
