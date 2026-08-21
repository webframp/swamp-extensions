## 2026.08.21.1

**Changed:** Schema-only tightening pass, no behavioral change.
- Added `.min(1)` to `apiKey`/`appKey` in the global arguments and to the
  required `event_id` argument on `get_event`, so empty identifiers are
  rejected before making an API call.
- Added `.describe()` to previously undocumented event attribute fields
  (`aggregation_key`, `date_happened`, `device_name`, `duration`,
  `hostname`, `monitor_groups`, `monitor_id`, `priority`,
  `related_event_id`, `service`, `source_type_name`, `sourcecategory`,
  `tags`, `timestamp`, `title`) on both the list and search event resource
  schemas, plus the `attributes`, `category`, and `integration_id`
  arguments on `create_event` and the `filter`, `options`, `page`, and
  `sort` arguments on `search_events`.
