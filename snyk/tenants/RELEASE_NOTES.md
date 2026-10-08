## 2026.10.07.1

**Added:** `list_models` and `get_model` methods for the Snyk Risk Database
model catalogue (`/tenants/{tenant_id}/risk_db/models`). `list_models` filters
by provider, risk-assessment status, last-updated date, and model name. They
write the new `models` and `model` resources. Both methods are Early Access in
the Snyk API.

**Fixed:** A request that never answers no longer hangs the method. Each attempt
now has a 30-second deadline, and a timeout names the method and path. Rate
limiting (HTTP 429) retries up to three times, waits at most 30 seconds between
tries, and then reports the rate limit instead of failing with a consumed-body
`TypeError`. An empty 2xx body (202, 204, or an empty 200) no longer fails JSON
parsing. A malformed JSON body now reports the HTTP status and the request
instead of a bare `SyntaxError`, and HTTP errors name the request too.
Pagination follows a relative `next` link with or without the `/rest` prefix,
and refuses a `next` link that leaves the Snyk API origin or the `/rest` path
instead of sending the API token to it. `update_tenant_role` now sends its
declared query parameters instead of dropping them.
`create_deployment_credential` received a list in `data` and stored an empty
object; it now stores the credentials under `items`.

**Changed:** Response schemas now accept what the API returns. Enumerated
response fields accept any value of their type, value constraints (`min`, `max`,
pattern) are dropped, response properties may be missing or null, and nested
objects keep fields the spec does not list, so one unexpected value no longer
fails a whole page. Methods that read or create a single resource now fail when
the API answers with an empty body where the spec promises content, instead of
storing an empty resource. Operations the spec documents as returning no content
(204) still succeed. Argument and field descriptions now end at a word boundary.
Request arguments are unchanged, except the array-valued query parameters
(`meta_fields`, `provider`), which now accept a string or a list of strings. A
list joins with commas or repeats the key, as the API specifies for that
parameter, and a plain string is sent unchanged. The
`broker_orgs_for_bulk_migration` resource is written by both a list and a get or
create method. Its schema now accepts what each writes, where the list wrapper
schema rejected the flat data.

**Upgrade note:** The loosened response schemas change validation behavior.
Stored resources remain valid, and no data migration is needed. Anything that
relied on a resource schema to reject an out-of-enum value or a missing field
must now check the data itself.
