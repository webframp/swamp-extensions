## 2026.08.21.2

**Changed:** Error messages and input validation are more specific.

- API errors now name the HTTP method and path that was attempted (e.g.
  `Datadog API HTTP 404: GET /api/v2/team-hierarchy-links/abc-123`) instead
  of just the raw status code and response body.
- A network-level failure (DNS error, connection reset, timeout) reaching the
  Datadog API now raises `Datadog API request failed: <METHOD> <path>: <reason>`
  instead of an unlabeled fetch error.
- `link_id` is now rejected up front if empty on `get_team_hierarchy_link`
  and `remove_team_hierarchy_link`, instead of building a malformed request
  path.

No changes to request/response shapes or existing successful-path behavior.

## 2026.08.21.1

**Changed:** Tightened and clarified Zod schemas as part of a repo-wide schema
audit.

- Added `.min(1)` to `apiKey` and `appKey` in the global arguments schema —
  both are sent directly as request headers, and an empty value would never
  be accepted by the Datadog API.
- Replaced the placeholder `"None"` description (a code-generation artifact)
  on 29 path-parameter arguments (`team_id`, `link_id`, `user_id`, `rule_id`,
  `action`, `user_uuid`) with real descriptions, and added `.min(1)` to each —
  every one of them is `encodeURIComponent`-ed directly into a request URL, so
  an empty value would always produce a malformed path.
- Added descriptions to previously undocumented `relationships`, `type`,
  `frequency`, `selection_state`, `source`, `sync_membership`, `role`,
  `email`, `ms_teams`, `pagerduty`, `slack`, and `value` arguments.

No behavioral changes — these are documentation and validation tightenings
only.

## 2026.07.20.11

**Added:** Initial code-generated release of @webframp/datadog/teams with 31
methods covering the Datadog teams API surface.
