## 2026.08.21.1

**Changed:** CloudWatch API failures now raise an error that names the failing
operation and the relevant filters (region, state value, alarm name prefix,
alarm name) instead of surfacing the raw AWS SDK error with no context. This
applies to `list_alarms`, `get_active`, `get_history`, and `get_summary`,
including the paginated `DescribeAlarms`/`DescribeAlarmHistory` calls inside
`get_summary`.

**Changed:** `limit` arguments on `list_alarms`, `get_active`, and
`get_history` now require a positive integer (capped at 10000); `historyHours`
on `get_summary` must be a positive number up to 720 (30 days). Previously
these accepted any number, including zero or negative values, which could
produce confusing pagination behavior instead of a clear validation error.
