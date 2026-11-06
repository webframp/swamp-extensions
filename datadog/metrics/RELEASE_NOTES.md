## 2026.11.06.1

**Added:** `list_tag_configurations` gains two optional filter arguments —
`filter_metrics_id` (map to `filter[metrics.id]`, match a metric name with
optional `*` wildcard) and `filter_historical_metrics` (map to
`filter[historical_metrics]`, restrict to metrics with historical ingestion
enabled).

**Changed:** `list_tag_configurations` description and its `tag_configurations`
resource description now read "List all metrics with volumes and query activity"
(previously "Get a list of metrics"). The `filter_metric_type` argument
description now notes that omitting it returns metrics of all types.

**Upgrade note:** Additive only — the new filter arguments are optional and no
resource schema changed, so stored data continues to validate. No migration
required.
