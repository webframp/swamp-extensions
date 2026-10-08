# @webframp/claude-cost-reconciliation

Reconcile the monthly AWS Marketplace **Claude Enterprise** invoice line against
Anthropic's own post-discount paid total, for the same calendar month.

The AWS Marketplace carries Claude Enterprise as a single private-offer
passthrough line (AWS bills you, AWS pays Anthropic). This extension answers one
question, repeatably:

> Does what AWS billed us for Claude Enterprise match what Anthropic's usage API
> says we were charged, for the same month?

It ships a **workflow** that collects both sides in parallel and a
**workflow-scope report** that joins them into a verdict.

## Install

```bash
swamp extension pull @webframp/claude-cost-reconciliation
```

This also pulls its dependencies, `@webframp/aws/cost-explorer` and
`@webframp/anthropic/analytics`. You need one model instance of each in your
repo:

- a `@webframp/aws/cost-explorer` instance with a profile that can read Cost
  Explorer for the payer account (e.g. `aws-costs`);
- a `@webframp/anthropic/analytics` instance with Enterprise Analytics API
  credentials (e.g. `claude-analytics`).

## Run

```bash
swamp workflow run @webframp/claude-cost-reconciliation --input month=2026-09
```

If your model instances are not named `aws-costs` / `claude-analytics`, pass
them:

```bash
swamp workflow run @webframp/claude-cost-reconciliation \
  --input month=2026-09 \
  --input awsModel=my-aws-costs \
  --input anthropicModel=my-claude-analytics
```

Tolerances default to **$50** or **0.5%** (whichever is satisfied passes). Set
tighter bounds for a single run:

```bash
swamp workflow run @webframp/claude-cost-reconciliation \
  --input month=2026-09 --input toleranceUsd=25 --input tolerancePct=0.25
```

## Read the result

```bash
# human-readable
swamp report get @webframp/claude-cost-reconciliation \
  --workflow claude-cost-reconciliation --markdown

# machine-readable (stable contract)
swamp report get @webframp/claude-cost-reconciliation \
  --workflow claude-cost-reconciliation --json
```

## Inputs

| Input            | Type   | Default            | Meaning                                                        |
| ---------------- | ------ | ------------------ | -------------------------------------------------------------- |
| `month`          | string | — (required)       | Billing month, `YYYY-MM`. Window is `[month-01, next-month-01)`. |
| `awsModel`       | string | `aws-costs`        | `@webframp/aws/cost-explorer` instance name.                   |
| `anthropicModel` | string | `claude-analytics` | `@webframp/anthropic/analytics` instance name.                 |
| `toleranceUsd`   | number | `50`               | Absolute dollar tolerance.                                     |
| `tolerancePct`   | number | `0.5`              | Percentage tolerance (percent).                                |

## Verdict and finality

**Verdict** (tolerance passes on EITHER the dollar floor OR the percentage):

- `MATCH` — within tolerance.
- `MISMATCH` — outside tolerance.
- `UNVERIFIABLE` — a precondition failed; no verdict is asserted. A trust
  failure is not a billing discrepancy, so it is a distinct state and is never
  folded into `MISMATCH`.

**Finality:**

- `FINAL` — the month has settled.
- `PROVISIONAL` — the month has not fully settled
  (`rangeExceedsWatermark`); the verdict is still computed but flagged, because
  a delta on an unsettled month is expected and not alarming.

### Gates (why a verdict may be withheld)

| Condition                              | Effect                       |
| -------------------------------------- | ---------------------------- |
| Anthropic `collected = false`          | UNVERIFIABLE (fetch failed)  |
| Anthropic `reconciliationChecked = false` | UNVERIFIABLE (untrustworthy) |
| AWS `truncated = true`                 | UNVERIFIABLE (incomplete)    |
| Anthropic `truncated = true`           | UNVERIFIABLE (incomplete)    |
| Windows disagree between the two sides | UNVERIFIABLE (wrong compare) |
| Anthropic total `$0` while AWS billed  | UNVERIFIABLE (cannot compare) |
| `rangeExceedsWatermark = true`         | verdict computed, PROVISIONAL |
| Absent/expired/malformed handle        | UNVERIFIABLE, `degraded: true` |

The report **degrades, never throws**: any failure path still returns a valid
`{ markdown, json }`.

## JSON contract

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
    "deltaUsd": -8.00,         // aws - anthropic
    "deltaPct": -0.067,
    "verdict": "MATCH",        // MATCH | MISMATCH | UNVERIFIABLE
    "finality": "FINAL",       // FINAL | PROVISIONAL
    "toleranceUsd": 50, "tolerancePct": 0.5
  },
  "notes": [ "…" ],
  "degraded": false,
  "generatedAt": "…"
}
```

<!-- Figures above are illustrative placeholders, not real billing data. -->


## Scope

Per-model showback is intentionally **out of scope**: the AWS Marketplace line
is a single rollup and cannot be split by model, so a per-model table would not
serve reconciliation. Per-model allocation lives in
`@webframp/anthropic/analytics`'s `collect_cost_by_model` and can get its own
report later if a consumer needs it. Amazon Bedrock usage is a separate cost
center and is excluded.

## License

Apache-2.0. See [LICENSE.md](./LICENSE.md).
