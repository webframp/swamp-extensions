## 2026.08.21.2

**Changed:** The `gpu-capex` model's `sensitivity` method now rejects an empty
`usefulLifeMonthsRange` or empty `utilizationPctRange` at validation time,
with a clear "at least 1 element" error, instead of silently returning a
sensitivity matrix with zero rows when either range is passed as `[]`.

No changes to the `record`, `project`, or `update_hardware_cost` methods, and
no changes to `gpu-cloud`, `gpu-rental`, or the comparison report.
