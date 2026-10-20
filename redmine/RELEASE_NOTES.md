## 2026.10.20.1

**Added:** `list_attachments` lists the attachments of an issue (ID, file name,
size, content type, author, date) into a new `attachments` resource, named
`attachments-<issueId>`. `download_attachments` downloads them in one run into a
new `attachment` file spec, named `attachment-<issueId>-<attachmentId>`. It
filters by attachment IDs or a content-type prefix (case-insensitive) and skips
files over `maxBytes` (default 20 MiB). Until now the type had no way to read an
attachment: `get_issue` does not request `include=attachments`, and
`upload_file` was the only file method.

The `attachments` resource always lists every attachment of the issue. After
`download_attachments` each one has a status: `downloaded`, `not-selected`,
`skipped-too-large` or `failed` (with an `error`), and `filter` records the
selection. The size limit applies to the bytes Redmine serves as well as to the
size it records. A file served as an HTML page (a login or proxy error page) is
`failed`, not stored. If any download fails, the method stores the files that
did download and the resource, then fails the run and names each failed
attachment.

**Fixed:** Every request sent `X-Redmine-API-Key` and `X-Redmine-Username` to
whatever host a redirect pointed at, because `fetch` strips only
`Authorization` on a cross-origin redirect. Redirects are now followed by hand:
a same-origin redirect keeps the credentials, a cross-origin one (for example to
an S3 or CDN storage backend) is followed without them, and more than 5
redirects fail the request.

**Changed:** Requests no longer wait forever on a server that stops answering.
JSON requests time out after 120 seconds per attempt, downloads after 60 seconds
without data, and `upload_file`'s upload after 10 minutes per attempt.
`upload_file`'s upload now also retries 429/502/503/504 like every other call.

**Upgrade note:** No `globalArguments` changes; existing instances move to this
version with an identity upgrade. Downloads send `X-Redmine-Username` when
`username` is set, like every other method.

## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.09.19.1

**Fixed:** `redmineApi`/`redmineApiPaginated` had no retry logic — any 429
(or 502/503/504) failed the request outright. A caller sequentially fetching
many issues (e.g. an enrichment step iterating over a large ticket list) can
trip Redmine's rate limiter even at concurrency 1, and every prior release
turned that into a hard failure. Both helpers now retry through a shared
`fetchWithRetry`, honoring `Retry-After` when the server sends one and
falling back to exponential backoff (up to 4 retries) otherwise.

## 2026.09.18.1

**Upgrade note:** Normalized `npm:zod` dependency version to 4.6.5 across the
repo. No behavioral changes in this extension.
