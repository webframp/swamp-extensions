## 2026.10.20.1

**Added:** `list_attachments` lists the attachments of an issue (ID, file name,
size, content type, author, date) into a new `attachments` resource, named
`attachments-<issueId>`. `download_attachments` downloads them in one run into a
new `attachment` file spec, named `attachment-<issueId>-<attachmentId>`, with
filters for attachment IDs and a content-type prefix, and a `maxBytes` limit
(default 20 MiB). Until now the type had no way to read an attachment:
`get_issue` does not request `include=attachments`, and `upload_file` was the
only file method.

An attachment over `maxBytes` gets the status `skipped-too-large` and does not
fail the run. The limit applies to the bytes Redmine actually serves as well as
to the size it records, and the download stops reading once it passes the limit.
Any other download failure fails the run and names the attachment.

**Upgrade note:** No `globalArguments` changes; existing instances move to this
version with an identity upgrade. Downloads send `X-Redmine-Username` when
`username` is set, like every other method, and retry 429/502/503/504 like the
JSON helpers.

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
