## 2026.08.21.2

**Changed:** Error messages and input validation are more specific.

- API errors now name the HTTP method and path that was attempted (e.g.
  `Datadog API HTTP 404: GET /api/v2/synthetics/tests/browser/abc-123/results`)
  instead of just the raw status code and response body.
- A network-level failure (DNS error, connection reset, timeout) reaching the
  Datadog API now raises `Datadog API request failed: <METHOD> <path>: <reason>`
  instead of an unlabeled fetch error.
- `create_synthetics_suite` and `edit_synthetics_suite` now reject an empty
  `tests` array before making a request.
- `get_test_file_multipart_presigned_urls` and
  `complete_test_file_multipart_upload` now reject an empty `parts` array
  before making a request, instead of letting Datadog return an opaque
  validation error for a multipart upload with no parts.

No changes to request/response shapes or existing successful-path behavior.

## 2026.08.21.1

**Changed:** Tightened Zod schemas as part of a repo-wide schema audit.

- Added `.min(1)` to `apiKey` and `appKey` in the global arguments schema —
  both are sent directly as request headers, and an empty value would never
  be accepted by the Datadog API.
- Added `.min(1)` to the required `public_id`, `downtime_id`, `test_id`, and
  `result_id` path-parameter arguments across all methods that
  `encodeURIComponent` them directly into a request URL — an empty value
  would always produce a malformed path and a guaranteed API error.

No behavioral changes — these are validation tightenings only; every value
these methods already accept from the Datadog API continues to validate.

## 2026.07.20.11

**Added:** Initial code-generated release of @webframp/datadog/synthetics with
35 methods covering the Datadog synthetics API surface.
