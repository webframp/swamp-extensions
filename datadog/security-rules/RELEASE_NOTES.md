## 2026.08.21.2

**Changed:** Error messages and input validation are more specific.

- API errors now name the HTTP method and path that was attempted (e.g.
  `Datadog API HTTP 404: GET /api/v2/security_monitoring/rules/abc-123`)
  instead of just the raw status code and response body.
- A network-level failure (DNS error, connection reset, timeout) reaching the
  Datadog API now raises `Datadog API request failed: <METHOD> <path>: <reason>`
  instead of an unlabeled fetch error.
- `create_security_monitoring_rule`, `convert_security_monitoring_rule_from_json_to_terraform`,
  and `validate_security_monitoring_rule` now reject an empty `cases` or
  `queries` array before making a request, instead of letting Datadog return
  an opaque validation error for a rule with no cases or queries.
- `bulk_delete_security_monitoring_rules` now rejects an empty `ruleIds`
  array before making a request.

No changes to request/response shapes or existing successful-path behavior.

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
