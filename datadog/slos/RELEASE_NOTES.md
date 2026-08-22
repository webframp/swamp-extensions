## 2026.08.21.2

**Changed:** Error messages and input validation are more specific.

- API errors now name the HTTP method and path that was attempted (e.g.
  `Datadog API HTTP 404: GET /api/v2/slo/abc-123/status`) instead of just the
  raw status code and response body.
- A network-level failure (DNS error, connection reset, timeout) reaching the
  Datadog API now raises `Datadog API request failed: <METHOD> <path>: <reason>`
  instead of an unlabeled fetch error.
- `report_id` and `slo_id` are now rejected up front if empty, instead of
  building a malformed request path.
- `create_slo_report_job` now rejects an empty `query`, and rejects `to_ts`
  values that are not after `from_ts`, before making a request — previously
  an inverted or zero-width time range would be sent to Datadog and fail (or
  silently return an empty report) with no explanation of why.

No changes to request/response shapes or existing successful-path behavior.

## 2026.08.21.1

**Changed:** Tightened and clarified Zod schemas as part of a repo-wide schema
audit.

- Added `.min(1)` to `apiKey` and `appKey` in the global arguments schema —
  both are sent directly as request headers, and an empty value would never
  be accepted by the Datadog API.
- Added a description to the previously undocumented `interval` argument on
  `create_slo_report_job`.

No behavioral changes — these are documentation and validation tightenings
only.

## 2026.07.20.11

**Added:** Initial code-generated release of @webframp/datadog/slos with 3
methods covering the Datadog slos API surface.
