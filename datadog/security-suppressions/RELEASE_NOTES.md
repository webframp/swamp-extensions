## 2026.08.21.2

**Changed:** Error messages and input validation are more specific.

- API errors now name the HTTP method and path that was attempted (e.g.
  `Datadog API HTTP 404: GET /api/v2/security_monitoring/configuration/suppressions/abc-123`)
  instead of just the raw status code and response body.
- A network-level failure (DNS error, connection reset, timeout) reaching the
  Datadog API now raises `Datadog API request failed: <METHOD> <path>: <reason>`
  instead of an unlabeled fetch error.
- `suppression_id` is now rejected up front if empty on every method that
  takes it, instead of building a malformed request path.
- `get_suppressions_affecting_future_rule` now rejects an empty `cases` or
  `queries` array before making a request, instead of letting Datadog return
  an opaque validation error for a rule preview with no cases or queries.

No changes to request/response shapes or existing successful-path behavior.

## 2026.08.21.1

**Changed:** Tightened and clarified Zod schemas as part of a repo-wide schema
audit.

- Added `.min(1)` to `apiKey` and `appKey` in the global arguments schema —
  both are sent directly as request headers, and an empty value would never
  be accepted by the Datadog API.
- Added descriptions to previously undocumented `options`, `schedulingOptions`,
  and `type` arguments on `get_suppressions_affecting_future_rule`.

No behavioral changes — these are documentation and validation tightenings
only.

## 2026.07.20.11

**Added:** Initial code-generated release of
@webframp/datadog/security-suppressions with 9 methods covering the Datadog
security suppressions API surface.
