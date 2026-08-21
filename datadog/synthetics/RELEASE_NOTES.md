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
