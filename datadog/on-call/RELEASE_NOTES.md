## 2026.08.21.2

**Changed:** Error messages and input validation are more specific.

- API errors now name the HTTP method and path that was attempted (e.g.
  `Datadog API HTTP 404: GET /api/v2/on-call/schedules/abc-123`) instead of
  just the raw status code and response body. This makes it possible to tell
  which call failed when a method makes more than one Datadog request.
- A network-level failure (DNS error, connection reset, timeout) reaching the
  Datadog API now raises `Datadog API request failed: <METHOD> <path>: <reason>`
  instead of an unlabeled fetch error, so it's clear which operation was in
  flight when the connection dropped.
- `create_on_call_escalation_policy` and `update_on_call_escalation_policy`
  now reject an empty `steps` array before making a request, instead of
  letting Datadog return an opaque validation error for a policy with no
  escalation steps.
- `create_on_call_schedule` and `update_on_call_schedule` now reject an empty
  `layers` array before making a request, for the same reason — a schedule
  with no layers is never valid.

No changes to request/response shapes or existing successful-path behavior.

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
