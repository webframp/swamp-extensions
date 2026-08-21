## 2026.08.21.1

**Changed:** Schema-only tightening pass, no behavioral change.
- Added `.min(1)` to `apiKey`/`appKey` in the global arguments and to the
  required `metric_name` argument across all ten methods that use it as a
  path parameter, so empty identifiers are rejected before making an API
  call.
- Added `.describe()` to previously undocumented fields: `id`,
  `relationships`, and `type` on the metric-assets resource schema; the
  `attributes` and `type` fields on the scalar/timeseries query response
  schemas; and the `aggregations`, `metric_type`, and `queries` arguments
  on `create_tag_configuration`, `update_tag_configuration`,
  `query_scalar_data`, and `query_timeseries_data`.
