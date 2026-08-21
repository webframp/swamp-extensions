## 2026.08.21.1

**Changed:** Tightened and clarified Zod schemas as part of a repo-wide schema
audit.

- Added `.min(1)` to `apiKey` and `appKey` in the global arguments schema —
  both are sent directly as request headers, and an empty value would never
  be accepted by the Datadog API.
- Added descriptions to previously undocumented `options`, `schedulingOptions`,
  `type`, `rule`, and `complianceSignalOptions` arguments across the
  create/update/validate/test rule methods.

No behavioral changes — these are documentation and validation tightenings
only.

## 2026.07.20.11

**Added:** Initial code-generated release of @webframp/datadog/security-rules
with 11 methods covering the Datadog security rules API surface.
