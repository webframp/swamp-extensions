## 2026.08.21.1

**Changed:** `DescribeAlarms` and `DescribeAlarmHistory` failures now name the
operation, the alarm name (or state filter, for triage), and region instead
of propagating the raw AWS SDK exception. Previously a throttling or
permissions error surfaced with no indication of which alarm or call was
responsible.

`investigate`'s `alarmName` argument now rejects an empty string before any
API call is made, instead of sending an empty `AlarmNames` filter to
CloudWatch and reporting a generic "alarm not found".
