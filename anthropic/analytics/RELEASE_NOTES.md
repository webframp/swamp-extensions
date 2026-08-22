## 2026.08.21.2

**Changed:** `startDate`/`endDate` on `collect_analytics` and `collect_user_usage`
are now validated as well-formed `YYYY-MM-DD` dates before any request is made.
Previously a malformed date (e.g. `"not-a-date"` or `"2026-13-99"`) silently
passed the range check — `Date` parsing of garbage input produces `NaN`, which
made the "end must be after start" comparison a no-op — and the bad value was
sent straight to the Analytics API, surfacing only as an opaque upstream 400.
Malformed dates now fail fast with a message naming the argument and the value
that was rejected.
