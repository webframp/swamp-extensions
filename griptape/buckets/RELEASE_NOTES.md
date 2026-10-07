## 2026.10.07.1

**Fixed:** An empty successful response (for example `202 Accepted`) no longer
fails with a JSON parse error. Mutating methods return no data handle for it,
and list methods treat an empty page as the end of the results.

**Fixed:** A malformed JSON body now fails with an error that names the HTTP
status, method, and path, instead of a bare `SyntaxError`.

**Fixed:** Requests no longer hang indefinitely. Each attempt has a 30-second
deadline and fails with `timed out after <n>ms: <METHOD> <path>`. Set
`GT_CLOUD_TIMEOUT_MS` to a positive integer up to 2147483647 to change it.
`Retry-After` waits on HTTP 429 are capped at 30 seconds.

**Fixed:** Pagination ends on its own page counter and stops at the first empty
page. A server that ignores the `page` parameter can no longer return page 1 up
to 20 times, and a list response that is not a JSON object fails with a clear
error instead of returning an empty result. A `null` `total_pages` no longer
ends pagination after the first page, and a `next_page` value keeps a short page
going.

**Fixed:** Descriptions in generated argument and resource schemas are shortened
at a word boundary instead of mid-word.

**Fixed:** `create`, `update`, and `delete` methods now send their declared
query parameters, as `get`, `list`, and action methods already did. No current
endpoint declares one, so behavior is unchanged today.

**Changed:** Stored resource schemas are now tolerant of unexpected data. Enums
are plain strings or numbers, pattern, length, and range constraints are
dropped, every response field accepts null or absence, unknown keys are kept at
every level, and spec defaults are no longer filled in. A response with a new
enum member or a missing field is stored instead of failing the whole call.
Argument validation for requests is unchanged.

**Changed:** A resource declared without a response body is now stored as a
loose object, so whatever the API returns is kept instead of being stripped to
`{}`.

**Changed:** Generated tests now exercise every method, assert the exact request
(HTTP method, path, query string, auth header, JSON body) and the written
resource, and cover the shared helper's error, timeout, retry, and empty-body
paths.

**Upgrade note:** No migration is required. Schemas only loosen, so previously
stored data stays valid, and the upgrade chain gains an identity entry. The
upstream Griptape API spec also changed (tag profiles, tags, license info, and
engine transports were added); none of those fall under this extension, so no
method here changed because of it.

## 2026.09.18.1

**Upgrade note:** Normalized `npm:zod` dependency version to 4.6.5 across the
repo. No behavioral changes in this extension.
