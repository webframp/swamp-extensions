## 2026.08.21.1

**Changed:** `group_id` and `issue_id` now must be non-empty strings — previously
an empty value passed schema validation and only failed deep inside the Snyk API
call with a generic 404. Errors from the Snyk API now name the HTTP method and
path that was attempted (e.g. `Snyk API request failed: GET /groups/.../issues
returned HTTP 404: ...`) instead of just the bare status and body. Network-level
failures (DNS, connection refused, TLS errors) that reach the Snyk API are now
also caught and reported with the operation and path that was being attempted,
rather than surfacing as an unhandled `fetch` exception.
