## 2026.08.23.1

**Fixed:** README documented a broken CLI flag (`--global` instead of
`--global-arg`) in every usage example, and described a single `costs`
resource instead of the five typed resources the code actually writes
(`costTrend`, `costByService`, etc.).

**Changed:** Documentation only — no code changes otherwise. Added a
`## Troubleshooting` section covering `Dimensions` filter mismatches in
`get_cost_by_usage_type`, the single-region API constraint, the wrapped
error format from failed `GetCostAndUsage` calls, the `dataPoints.length >= 2`
guard that forces a `"stable"` trend for single-day windows, and
`get_cost_comparison`'s two sequential API calls.
