## 2026.09.23.1

**Added:** Report normalizers for the daily-briefing workflow's expanded AWS
ops signals, so the new fetch steps render in the briefing instead of being
skipped as unrecognized:

- **Security Hub** — the `diff_findings` delta (new/resolved findings since the
  last run, escalating to `critical` on new CRITICAL findings) and the
  `resolve_accounts` account map (recognized but deliberately not emitted, so
  account identifiers never surface and it no longer trips the "no recognizable
  shape" note).
- **Cost Explorer** — `cost_comparison` (period-over-period `spend-delta`,
  warns at ≥10% rise and names the top service driver) and `top_cost_drivers`.
- **ECR** (`@webframp/aws/ecr-observation`) — fleet image-hygiene signal from
  the survey aggregate (ADR-011 naming violations, repos without a lifecycle
  policy); per-account detail is never surfaced.
- **Kiro usage** (`@webframp/aws/kiro-usage`) — net Bedrock seat spend and user
  count for the billing month; warns on overage; per-user rows redacted.
- **GitLab logs** (`@webframp/aws/logs`) — an intentionally ungraded factual
  error-keyword signal (the severity call is made by the TypeSafe verdict, not
  the raw count, since the EKS clusters emit high-volume audit noise).
- **TypeSafe verdicts** (`@swamp/typesafe-ai`) — the interpretation `ask`
  evaluations on the security, cost, and logs signals, graded from each
  evaluation's ordered score legend. Per-MR triage resources from the same
  model are recognized and skipped (they feed the queue ordering, not ops).

**Changed:** The Security Hub normalizer now tracks recognized-but-unemitted
shapes separately from emitted signals, so a step that produced only an account
map is not falsely flagged degraded.

**Upgrade note:** No schema, method, or resource change. Report source changes
are shipped-file changes, so the version bumps and a no-op upgrade-chain entry
is appended for the `metrics` model.


(all permissions). The unit tests need no filesystem, network, or subprocess
access — they exercise pure report/model logic through the swamp-testing
factories — so the blanket grant was unnecessary. This matches the scoped
permission convention used by every other model/report extension in the repo.

**Upgrade note:** No schema, method, or resource change. A `deno.json` change
is a shipped-file change, so the version bumps and a no-op upgrade-chain entry
is appended for the `metrics` model.
