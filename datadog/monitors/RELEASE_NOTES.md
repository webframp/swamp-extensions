## 2026.08.21.1

**Changed:** Schema-only tightening pass, no behavioral change.
- Added `.min(1)` to `apiKey`/`appKey` in the global arguments and to the
  required `rule_id`/`policy_id` identifiers across the notification-rule
  and config-policy get/update/delete methods, so empty identifiers are
  rejected before making an API call.
- Added `.describe()` to previously undocumented fields: the nested
  `conditional_recipients.conditions`/`fallback_recipients` fields on the
  notification-rule resource schemas, and the `conditional_recipients`,
  `filter`, `name`, `recipients`, `policy`, and `policy_type` arguments on
  the `create`/`update_monitor_notification_rule` and
  `create`/`update_monitor_config_policy` methods.
