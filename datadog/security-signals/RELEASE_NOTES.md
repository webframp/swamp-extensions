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
