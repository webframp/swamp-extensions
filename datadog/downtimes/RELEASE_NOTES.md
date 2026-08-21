## 2026.08.21.1

**Changed:** Schema-only tightening pass, no behavioral change.
- Added `.min(1)` to `apiKey`/`appKey` in the global arguments and to the
  required `downtime_id`/`monitor_id` identifiers on the get, update,
  cancel, and list-monitor-downtimes methods, so empty identifiers are
  rejected before making an API call.
- Added `.describe()` to the previously undocumented `display_timezone`,
  `message`, `monitor_identifier`, `mute_first_recovery_notification`,
  `notify_end_states`, `notify_end_types`, `schedule`, and `scope`
  arguments on the `create_downtime` and `update_downtime` methods.
