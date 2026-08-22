## 2026.08.21.1

**Changed:** `test_id` and `rule_extension_id` now must be non-empty strings —
previously an empty value passed schema validation and only failed deep inside
the Snyk API call with a generic 404. Errors from the Snyk API now name the
HTTP method and path that was attempted instead of just the bare status and
body. Network-level failures (DNS, connection refused, TLS errors) reaching the
Snyk API are now also caught and reported with the operation and path that was
being attempted, rather than surfacing as an unhandled `fetch` exception.
