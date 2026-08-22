## 2026.08.21.2

**Changed:** Error messages and input validation are more specific.

- API errors now name the HTTP method and path that was attempted (e.g.
  `Datadog API HTTP 404: GET /api/v2/security_monitoring/signals/abc-123`)
  instead of just the raw status code and response body.
- A network-level failure (DNS error, connection reset, timeout) reaching the
  Datadog API now raises `Datadog API request failed: <METHOD> <path>: <reason>`
  instead of an unlabeled fetch error.
- `signal_id` is now rejected up front if empty on every method that takes
  it, instead of building a malformed request path.
- `edit_security_monitoring_signal_incidents` now requires `incident_ids` to
  be a non-empty array of integers (it was previously typed as `unknown` and
  accepted anything, including nothing at all).

No changes to request/response shapes or existing successful-path behavior.

## 2026.08.21.1

**Changed:** Tightened and clarified Zod schemas as part of a repo-wide schema
audit.

- Added `.min(1)` to `apiKey` and `appKey` in the global arguments schema —
  both are sent directly as request headers, and an empty value would never
  be accepted by the Datadog API.
- Added descriptions to previously undocumented `filter`, `page`, `sort`,
  `assignee`, `incident_ids`, `version`, `archive_comment`, `archive_reason`,
  and `state` arguments on the search and triage-edit methods, matching the
  wording already used for the equivalent resource schema fields.
- Added a description to the `result` field on the bulk-edit resource
  schemas.

No behavioral changes — these are documentation and validation tightenings
only.

## 2026.07.20.11

**Added:** Initial code-generated release of @webframp/datadog/security-signals
with 12 methods covering the Datadog security signals API surface.
