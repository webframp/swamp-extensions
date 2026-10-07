## 2026.10.07.1

**Added:** `collect_cost_by_model` method and `costByModel` resource. Reports
per-model token cost over a window from `/analytics/cost_report`
(`group_by=model`): list vs. paid USD per model, `discountUsd`/`discountPct`,
optional per-model token-type cost split (`groupBy: ["token_type"]`), and the
unattributed (model-less, e.g. code-execution) total. Issues a second
*ungrouped* query for the same window to obtain authoritative totals, so the
per-bucket top-100 group cap becomes detectable via a `truncated` flag rather
than silently under-reporting. Surfaces the export `dataRefreshedAt` watermark
and a `rangeExceedsWatermark` flag so not-yet-final recent months are explicit.
Trusts the API's own post-discount `amount` and pre-discount `list_amount`
(does not re-apply `discountRate`). Window spans at most 31 days (the API max);
call once per month for longer ranges. The resource also carries
`totalPaidCents` (an exact reconciliation anchor, since per-model USD values are
rounded independently and may not sum to `totalPaidUsd`), `modelsFilter` (echoes
any `models[]` filter — totals are scoped to it when set, not org-wide), and
`reconciliationChecked` (false when the ungrouped query returns an unexpected
dimensioned shape, in which case `truncated` is set conservatively). The
watermark comparison uses numeric instants, not string compare, so
non-canonical RFC 3339 timestamps are handled correctly. Additive — existing
resources are unaffected.

## 2026.09.18.1

**Upgrade note:** Normalized `npm:zod` dependency version to 4.6.5 across the
repo. No behavioral changes in this extension.
