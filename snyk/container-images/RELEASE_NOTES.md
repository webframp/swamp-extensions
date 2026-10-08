## 2026.10.07.1

**Fixed:** A request that never answers no longer hangs the method. Each attempt
now has a 30-second deadline, and a timeout names the method and path. Rate
limiting (HTTP 429) retries up to three times, waits at most 30 seconds between
tries, and then reports the rate limit instead of failing with a consumed-body
`TypeError`. An empty 2xx body (202, 204, or an empty 200) no longer fails JSON
parsing. A malformed JSON body now reports the HTTP status and the request
instead of a bare `SyntaxError`, and HTTP errors name the request too.
Pagination follows a relative `next` link with or without the `/rest` prefix,
and refuses a `next` link that leaves the Snyk API origin or the `/rest` path
instead of sending the API token to it.

**Changed:** Response schemas now accept what the API returns. Enumerated
response fields accept any value of their type, value constraints (`min`, `max`,
pattern) are dropped, response properties may be missing or null, and nested
objects keep fields the spec does not list, so one unexpected value no longer
fails a whole page. Methods that read or create a single resource now fail when
the API answers with an empty body where the spec promises content, instead of
storing an empty resource. Operations the spec documents as returning no content
(204) still succeed. Argument and field descriptions now end at a word boundary.
Request arguments are unchanged, except the array-valued query parameters
(`image_ids`, `names`), which now accept a string or a list of strings. A list
joins with commas or repeats the key, as the API specifies for that parameter,
and a plain string is sent unchanged. The `container_image` resource is written
by both a list and a get or create method. Its schema now accepts what each
writes, where the list wrapper schema rejected the flat data.

**Upgrade note:** The loosened response schemas change validation behavior.
Stored resources remain valid, and no data migration is needed. Anything that
relied on a resource schema to reject an out-of-enum value or a missing field
must now check the data itself.
