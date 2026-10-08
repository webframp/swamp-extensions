# Design Spec — Claude Cost Reconciliation (workflow + report)

**Status:** DRAFT — awaiting approval before implementation
**Author:** Kiro (with Sean)
**Date:** 2026-10-07

## 1. Problem

Each month the AWS Marketplace invoice carries a single "Claude Enterprise"
line (a private-offer passthrough to Anthropic). We need a repeatable way to
answer one question:

> Does what AWS billed us for Claude Enterprise match what Anthropic's own
> usage API says we were charged, for the same calendar month?

Today this is a manual investigation (done once for a recent month, which
settled within a sub-percent delta well inside tolerance). This spec turns that
into a parameterized, self-contained pipeline.

Explicitly **out of scope** (decided with Sean): per-model showback. The AWS
side cannot be split by model (the Marketplace line is one rollup), so a
per-model table does not serve reconciliation and would dilute the verdict.
Per-model lives in `collect_cost_by_model` already and can get its own report
later if a consumer needs allocation data. YAGNI.

## 2. Shape (decided: 1b — workflow + report)

A **workflow** collects both sides for the target month, then an attached
**workflow-scope report** joins them and renders the verdict. Self-contained
and repeatable (same pattern as daily-briefing): one `swamp workflow run`
produces the reconciliation.

A report-only approach was rejected: it would silently render stale/absent data
if the two methods hadn't been run for the month.

## 3. Inputs

The workflow takes one input:

| Input | Type | Meaning |
|-------|------|---------|
| `month` | `YYYY-MM` | Billing month to reconcile |

Derived in the workflow (CEL on the input):
- `startDate = <month>-01`
- `endDate = first day of the following month` (exclusive, per Cost Explorer
  and Anthropic cost_report semantics)

Month-arithmetic note: `endDate` must roll the year over for December
(`2026-12` -> `2027-01-01`). The workflow computes this; the report does not
re-derive dates (it reads them back from the produced data).

## 4. Data sources (both already exist, both pulled at 2026.10.07.1)

### AWS side — `@webframp/aws/cost-explorer` method `get_cost_for_period`
- Called with `start`, `end`, `service="Claude Enterprise"`, granularity
  MONTHLY.
- Produces a `costForPeriod` resource. Relevant fields:
  - `totalCost` — the "Claude Enterprise" service total (the invoice line).
  - `groups[]` — usage-type rows (`MP:usage_fee-Units`, seat-day line).
  - `truncated` — pagination cap flag.
  - `start`, `end`, `service`.
- Model instance: `aws-costs` (global profile `jw-cd-root/ReadOnlyPlus`).

### Anthropic side — `@webframp/anthropic/analytics` method `collect_cost_by_model`
- Called with `startDate`, `endDate` (same window).
- Produces a `costByModel` resource. Relevant fields:
  - `totalPaidUsd` — post-discount paid total (the comparison figure).
  - `totalListUsd`, `totalDiscountUsd` — list vs paid context.
  - `unattributedUsd` — model-less slice (footnote only).
  - `truncated`, `reconciliationChecked` — trust flags.
  - `rangeExceedsWatermark`, `dataRefreshedAt` — finality signals.
  - `collected` — false on API failure.
- Model instance: `claude-analytics`.

> We reuse `collect_cost_by_model` rather than `collect_analytics` because it
> carries the trust/finality flags (`reconciliationChecked`,
> `rangeExceedsWatermark`) that the reconciliation verdict depends on. We ignore
> its per-model rows for this report.

## 5. Workflow DAG — `claude-cost-reconciliation`

```
input: month (YYYY-MM)

job reconcile:
  step aws_cost:
    model:  aws-costs
    method: get_cost_for_period
    args:   start=<month>-01  end=<next-month>-01  service="Claude Enterprise"
  step anthropic_cost:
    model:  claude-analytics
    method: collect_cost_by_model
    args:   startDate=<month>-01  endDate=<next-month>-01
  # both steps independent -> run in parallel
report: @webframp/claude-cost-reconciliation   (workflow scope)
```

Both method steps are independent (different models, no data dependency) so
they run concurrently. The report runs after, reading both steps' data handles
from the workflow context.

Idempotency: both methods are read-only observations; re-running for the same
month reproduces the same versioned snapshots. No guards needed, but each
method already no-ops cleanly on re-run.

## 6. The report — `@webframp/claude-cost-reconciliation`

Workflow-scope report. `execute(context)` walks `context.stepExecutions`,
finds the two steps by `modelType`, reads their data handles via the shared
`readJson` helper (copied into this extension's `_lib/`, matching
operator-briefing's pattern — the helper is not a shared package).

### 6.1 Join + verdict logic

```
awsPaid      = costForPeriod.totalCost
anthroPaid   = costByModel.totalPaidUsd
delta        = awsPaid - anthroPaid            (AWS minus Anthropic)
deltaPct     = delta / anthroPaid * 100        (guard anthroPaid == 0)
absDelta     = |delta|
```

**Tolerance verdict** (both must pass for MATCH):
- `absDelta <= toleranceUsd`  (default $50), OR
- `|deltaPct| <= tolerancePct` (default 0.5%)

Use OR, not AND: a large invoice with a sub-percent delta should pass on the
percentage even if the dollar delta exceeds $50; a tiny invoice with a few
dollars delta should pass on the dollar floor. (A real settlement delta of a
few dollars on a five-figure invoice passes the $50 floor, and its sub-percent
figure passes the 0.5%.) Verdict values:
- `MATCH` — within tolerance.
- `MISMATCH` — outside tolerance.
- `UNVERIFIABLE` — a precondition failed (see 6.2); no verdict asserted.

### 6.2 Finality + trust gates (these gate the verdict)

The verdict is only meaningful if the data is trustworthy and final:

- If `costByModel.collected == false` -> `UNVERIFIABLE` (Anthropic fetch failed).
- If `costByModel.reconciliationChecked == false` -> `UNVERIFIABLE`
  (Anthropic total untrustworthy; it is zeroed in that case anyway).
- If `costForPeriod.truncated == true` -> `UNVERIFIABLE` (AWS total incomplete).
- If `costByModel.rangeExceedsWatermark == true` -> verdict still computed but
  **labeled PROVISIONAL** (the month has not settled; a delta here is expected
  and not alarming). A fully-settled month is labeled FINAL.
- If either data handle is absent/parse-fails -> `UNVERIFIABLE` + `degraded`.

This is the core correctness point: the report must never render a confident
MATCH/MISMATCH off incomplete or non-final data. The flags from both upstream
methods exist precisely to make this decidable.

### 6.3 Config (report config schema)

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `toleranceUsd` | number | `50` | Absolute dollar tolerance |
| `tolerancePct` | number | `0.5` | Percentage tolerance |

### 6.4 JSON contract (stable, the real output)

```jsonc
{
  "month": "2026-01",
  "window": { "start": "2026-01-01", "end": "2026-02-01" },
  "aws":   { "paidUsd": 12000.00, "truncated": false,
             "usageFeeUsd": 12000.00, "seatDayUsd": 0 },
  "anthropic": { "paidUsd": 12008.00, "listUsd": 12008.00,
                 "discountUsd": 0, "unattributedUsd": 0,
                 "reconciliationChecked": true, "truncated": false },
  "reconciliation": {
    "deltaUsd": -8.00,         // aws - anthropic (illustrative placeholders)
    "deltaPct": -0.067,
    "verdict": "MATCH",        // MATCH | MISMATCH | UNVERIFIABLE
    "finality": "FINAL",       // FINAL | PROVISIONAL
    "toleranceUsd": 50, "tolerancePct": 0.5
  },
  "notes": [ ... ],            // caveats, degradation reasons
  "degraded": false,
  "generatedAt": "..."
}
```

### 6.5 Markdown render

- One-line headline verdict with an icon: MATCH / MISMATCH / UNVERIFIABLE and
  FINAL/PROVISIONAL.
- A small two-row table: AWS Claude Enterprise vs Anthropic paid, plus delta
  ($ and %).
- Footnotes (always): Bedrock excluded (separate cost center); AWS Marketplace
  line cannot be split by model; `unattributedUsd` if non-zero; finality note
  if provisional; any degradation reasons.

## 7. State / lifecycle

The report produces no persisted model data of its own beyond the standard
report artifact the workflow records (readable via
`swamp report get @webframp/claude-cost-reconciliation --workflow
claude-cost-reconciliation --json`). The two upstream `costForPeriod` /
`costByModel` resources are the versioned state; each month is a distinct
instance, so historical reconciliations persist and are re-queryable.

## 8. Consumer contract

Primary consumer: whoever signs off the monthly invoice. They read the headline
verdict + finality. A programmatic consumer reads `.json.reconciliation.verdict`
and `.finality`. No existing consumer depends on this (new report), so it is
purely additive.

## 9. New extension layout

A new extension `claude-cost-reconciliation` (it spans two models, so it
belongs to neither `aws/*` nor `anthropic/*`):

```
claude-cost-reconciliation/
  manifest.yaml                 # version 2026.10.07.1, registers the report + workflow
  RELEASE_NOTES.md
  README.md
  deno.json
  extensions/
    reports/
      reconciliation.ts         # the workflow-scope report
      reconciliation_test.ts
      _lib/
        read.ts                 # copied readJson helper (degrade contract)
  workflows/
    claude-cost-reconciliation.yaml
```

Open question for review: should the workflow ship **inside this extension**
(so `swamp extension pull` brings both report and workflow), or live in the
devsecops repo as a local workflow referencing the published report? Shipping it
in the extension is more self-contained and matches operator-briefing (which
ships `workflows/*.yaml`). **Recommendation: ship the workflow in the
extension.**

## 10. Failure modes (enumerated)

| Failure | Handling |
|---------|----------|
| Anthropic API down | `collected=false` -> UNVERIFIABLE + note |
| AWS CE thrott/err | step fails; report sees absent handle -> UNVERIFIABLE + degraded |
| Month not settled | `rangeExceedsWatermark` -> PROVISIONAL label |
| AWS page cap hit | `costForPeriod.truncated` -> UNVERIFIABLE |
| Anthropic group cap | `reconciliationChecked=false` -> UNVERIFIABLE |
| `anthroPaid == 0` | guard div-by-zero; if both 0 -> MATCH(trivial) else UNVERIFIABLE |
| Both handles absent | degrade: valid `{markdown,json}` with `degraded:true` |
| Future/invalid month | workflow date derivation + method validation reject |

## 11. Testing plan

Unit tests on the report `execute` with a mock `dataRepository` + synthetic
`stepExecutions`:
1. Happy path (synthetic figures) -> MATCH / FINAL, sub-percent delta.
2. Delta beyond tolerance -> MISMATCH.
3. `rangeExceedsWatermark=true` -> verdict computed but PROVISIONAL.
4. `reconciliationChecked=false` -> UNVERIFIABLE.
5. `costForPeriod.truncated=true` -> UNVERIFIABLE.
6. `collected=false` -> UNVERIFIABLE.
7. absent AWS handle -> degraded + UNVERIFIABLE.
8. `anthroPaid==0` div-by-zero guard.
9. tolerance OR-logic: large-value sub-percent passes on %, small-value passes
   on $ floor.
10. markdown contains the headline verdict + both footnotes.

## 12. Versioning / deployment

New extension, first version `2026.10.07.1`. Manifest + source + RELEASE_NOTES
aligned. CI auto-publishes on merge (Sean never pushes from this machine); then
`swamp extension pull` into devsecops and the workflow is runnable.

## 13. Review questions

1. Workflow shipped in the extension (recommended) vs local to devsecops?
2. Tolerance defaults: $50 / 0.5% reasonable, or tighter?
3. Verdict on a provisional month: compute-but-label (recommended) vs withhold?
4. Is `UNVERIFIABLE` the right third state, or fold truncation/trust failures
   into `MISMATCH`? (Recommend keeping separate — a trust failure is not a
   billing discrepancy.)
```
