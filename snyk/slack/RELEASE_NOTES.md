## 2026.08.21.1

**Changed:** Errors from the Snyk API are now easier to diagnose. Previously,
a connection failure (DNS outage, timeout, refused connection) surfaced only
the raw fetch error with no indication of which Snyk endpoint was being
called. HTTP error responses named the status code but not the request that
triggered it. Both cases now include the HTTP method and path (e.g.
`GET /orgs/.../slack_app/.../channels`), so a failure can be traced back to
the method that caused it without reproducing the call.
