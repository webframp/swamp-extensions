## 2026.09.04.1

**Changed:** Bump @aws-sdk/* 3.1121.0 → 3.1126.0 (3 packages)

## 2026.09.01.1

**Added:** Initial release of `@webframp/aws/kiro-usage`.

Per-user AWS Kiro usage and spend monitoring sourced from the Cost and Usage
Report (CUR) via Athena — the only path that attributes Kiro spend and credit
consumption to individuals, since Cost Explorer collapses Kiro line items to
`NoResourceId`.

- **`scan` method** — queries one billing period for per-user seat cost
  (by tier) and credit consumption, resolves IAM Identity Store principals to
  names/emails, and reconciles the account-level enterprise discount (EDP).
  Defaults to the most recent complete month; accepts an explicit `month`.
- **`scan_results` resource** — per-user rows, per-tier rollup, account-level
  gross/discount/net reconciliation, and grand totals.
- **`@webframp/aws/kiro-usage-report`** — method-scope report rendering the
  per-user table, tier rollup, and reconciliation as markdown + JSON.
- **PII posture** — identity resolution is opt-in via `resolveIdentities`.
- **Duplicate accounts** — optional `mergeAccounts` map folds secondary
  Identity Store accounts into a primary for accurate per-person rollups.

**Upgrade note:** New extension; no prior versions and no migration.
