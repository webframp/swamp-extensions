## 2026.08.21.2

**Changed:** Every Datadog API call made by this model (via the shared
`_lib/api.ts` helper) now names the HTTP method and path in its error
message, instead of a bare "Datadog API HTTP 500: ...". A failure now reads,
for example, `Datadog API POST /api/v2/logs failed with HTTP 500: ...`
rather than just the status code and response body. Network-level failures
(DNS, connection reset, etc.) that previously surfaced as a raw `TypeError`
now also say which Datadog operation was being attempted.

`submit_log` now rejects an empty `entries` array at validation time with a
clear "at least 1 element" error, instead of silently sending a no-op
request to the Datadog Logs API.

No other changes to method arguments, resource schemas, or successful-call
behavior.
