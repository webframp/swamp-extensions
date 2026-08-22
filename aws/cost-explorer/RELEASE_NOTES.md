## 2026.08.21.1

**Changed:** Cost Explorer API failures across all five methods now raise an
error naming the failing `GetCostAndUsage` call and the query shape (grouping
dimensions, date range, or service filter) instead of surfacing the raw AWS
SDK error with no context.

**Changed:** `days` on all methods must now be a positive integer up to 365;
`limit` on `get_top_cost_drivers` must be a positive integer up to 1000; and
`service` on `get_cost_by_usage_type` must be a non-empty string. Previously
these accepted any number/string, including zero, negative, or empty values.
