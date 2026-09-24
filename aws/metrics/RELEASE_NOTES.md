## 2026.09.24.1

**Added:** `get_metric_data` method. Same arguments as `get_data` plus optional
`instanceName`, but calls `GetMetricData` instead of `GetMetricStatistics`:
paginated via `NextToken` (bounded at 10 pages), and usable by roles granted
only `cloudwatch:GetMetricData`. Writes the existing `metric_data` resource.

**Added:** Optional `sum` and `truncated` fields on `metric_data`, set by
`get_metric_data`. `sum` is the total of all datapoint values, or `null` when
the metric returned none (unknown, not zero). `truncated` is `true` when
pagination stopped at its cap.

**Changed:** Nothing for existing methods. `get_data` still calls
`GetMetricStatistics`. Stored resources from earlier versions remain valid: the
new fields are optional.
