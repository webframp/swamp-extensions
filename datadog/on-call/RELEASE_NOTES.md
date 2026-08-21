## 2026.08.21.1

**Changed:** Tightened and clarified Zod schemas as part of a repo-wide schema
audit.

- Added `.min(1)` to `apiKey` and `appKey` in the global arguments schema —
  both are sent directly as request headers, and an empty value would never
  be accepted by the Datadog API.
- Added descriptions to previously undocumented `relationships` and `type`
  fields in the team on-call users and team routing rules resource schemas.
- Added a description to the `category` argument on
  `create_user_notification_rule` and `update_user_notification_rule`,
  clarifying it takes `high_urgency` or `low_urgency`.

No behavioral changes — these are documentation and validation tightenings
only.

## 2026.07.20.11

**Added:** Initial code-generated release of @webframp/datadog/on-call with 21
methods covering the Datadog on call API surface.
