# Release Notes — @webframp/claude-cost-reconciliation

## 2026.10.07.1

Initial release.

### Added

- **Workflow `@webframp/claude-cost-reconciliation`** — takes a `month`
  (YYYY-MM) input, derives the window `[<month>-01, next-month-01)` (end
  exclusive; December rolls the year over), and runs two independent read-only
  observations in parallel:
  - `@webframp/aws/cost-explorer` `get_cost_for_period` filtered to the
    "Claude Enterprise" service (MONTHLY).
  - `@webframp/anthropic/analytics` `collect_cost_by_model` for the same window.

  Model instance names are inputs (`awsModel` default `aws-costs`,
  `anthropicModel` default `claude-analytics`) — never hardcoded. Tolerances
  are inputs (`toleranceUsd` default 50, `tolerancePct` default 0.5, both
  `minimum: 0`), overridable per run.

- **Workflow-scope report `@webframp/claude-cost-reconciliation`** — joins both
  steps' resources into a reconciliation verdict:
  - `verdict`: `MATCH` / `MISMATCH` / `UNVERIFIABLE`.
  - `finality`: `FINAL` / `PROVISIONAL`.
  - Tolerance passes on EITHER the dollar floor OR the percentage.
  - Trust/finality gates: `collected=false` or `reconciliationChecked=false`
    (fail-closed on trust) → UNVERIFIABLE; either side `truncated` → UNVERIFIABLE;
    `rangeExceedsWatermark` → verdict still computed but labeled PROVISIONAL
    (fail-open on finality). A disagreeing window between the two sides →
    UNVERIFIABLE.
  - Reads tolerances from the workflow run inputs; falls back to the defaults
    when run standalone.
  - DEGRADES, NEVER THROWS: an absent/expired handle, a parse failure, or any
    unexpected error yields a valid `{ markdown, json }` with
    `verdict: "UNVERIFIABLE"` and `degraded: true`.

### Notes

- Per-model showback is intentionally out of scope: the AWS Marketplace line is
  a single rollup and cannot be split by model. Amazon Bedrock usage is a
  separate cost center and is excluded.
- Depends on `@webframp/aws/cost-explorer@2026.10.07.1` and
  `@webframp/anthropic/analytics@2026.10.07.1`.
