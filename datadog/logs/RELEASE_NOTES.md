## 2026.08.21.1

**Changed:** Schema-only tightening pass, no behavioral change.
- Added `.min(1)` to `apiKey`/`appKey` in the global arguments, so empty
  credentials are rejected before making an API call.
- Added `.describe()` to the previously undocumented `filter`, `options`,
  and `page` arguments on `aggregate_logs`, and the `filter`, `options`,
  `page`, and `sort` arguments on `list_logs`.
