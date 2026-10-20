## 2026.10.20.1

**Added:** `list_attachments` lists the attachments of an issue (ID, file name,
size, content type, author, date) into a new `attachments` resource, named
`attachments-<issueId>`. `download_attachments` downloads them in one run into a
new `attachment` file spec, named `attachment-<issueId>-<attachmentId>`. It
filters by attachment IDs or a content-type prefix (case-insensitive) and skips
files over `maxBytes` (default 20 MiB). Until now the type had no way to read an
attachment.

The `attachments` resource always lists every attachment of the issue, with a
status (`listed` after `list_attachments`; `downloaded`, `not-selected`,
`skipped-too-large` or `failed` with an `error` after `download_attachments`)
and, for downloaded ones, the `dataName` of the stored file. `filter` records
the selection and `maxBytes`. The size limit applies to the bytes Redmine serves
as well as to the size it records. A non-HTML attachment served as an HTML page
(a login or proxy error page) is `failed`, not stored. If any download fails,
the method stores the files that did download and the resource, then fails the
run naming each failed attachment.

**Fixed:** Every request sent `X-Redmine-API-Key` and `X-Redmine-Username` to
whatever host a redirect pointed at, because `fetch` strips only `Authorization`
on a cross-origin redirect.

**Fixed:** Methods overwrote each other's stored data. Swamp stores data by
name, not by spec. `list_statuses`, `list_trackers`, `list_projects`,
`list_custom_fields`, and unfiltered `list_issues` and `list_time_entries` all
wrote `all`. `get_issue`, `create_issue`, `update_issue`, `list_relations`,
`list_time_entries` by issue, `get_version` and `create_version` wrote bare
numeric IDs, and `search` wrote the bare sanitized query. `list_users`,
`list_versions`, `list_time_entries` and `list_issue_categories` wrote the bare
project. Within one method, `list_time_entries` ignored the user and date
filters, and `search` mapped `foo bar` and `foo-bar` to the same name. Every
data name now carries a spec prefix and every filter (see **Upgrade note**).

**Fixed:** The SPDX header in `redmine.ts` and its test said AGPL-3.0-or-later.
Every source file now says Apache-2.0, matching `LICENSE.md` and the manifest.

**Changed:** A redirect to another origin now fails an API call with a message
naming the URL to set as `host`. A same-origin redirect, or an http→https
upgrade of the same host name on any port, still works. `download_attachments`
follows other redirects without the credentials (S3 or CDN storage backends).

**Changed:** Only reads (GET) retry a 502, a 504 or a 503 without `Retry-After`.
A gateway can time out after Redmine committed a write, so retrying created a
duplicate issue or upload, added a second journal note, or reported a 404 for a
delete that succeeded. Every method still retries a 429, and a 503 that carries
`Retry-After` (a throttle rejecting before any work), unless the write was
redirected. A `Retry-After` longer than 60 seconds is no longer slept on (it
blocked the method for up to 4 × the value); the request fails instead. An
HTTP-date `Retry-After` is now honored. `upload_file`'s upload now uses the same
retry and redirect handling as every other call.

**Changed:** `list_time_entries` rejects `from` and `to` values that are not
real `YYYY-MM-DD` dates. Redmine ignored a malformed date and returned
unfiltered entries.

**Fixed:** The `limit` descriptions of `list_issues` and `list_time_entries`
said "default 25"; the default is 100, the maximum 500.

**Changed:** Requests no longer wait forever on a server that stops answering.
JSON requests time out after 120 seconds per attempt, downloads after 60 seconds
without data, and `upload_file`'s upload after 10 minutes per attempt.

**Upgrade note:** Data names change. Update any `data.latest(...)` or
`model.<name>.resource.<spec>.<name>` reference:

- `all` → `statuses-all`, `trackers-all`, `projects-all`, `custom-fields-all`,
  `issues-all`, `time-entries-all`
- `<project>` → `users-<project>`, `versions-<project>`,
  `issue-categories-<project>`
- `<filters>` → `issues-<filters>`; `<issueId>` → `issue-<issueId>`,
  `relations-<issueId>`; `<versionId>` → `version-<versionId>`
- time entries → `time-entries-<filters>` (e.g. `time-entries-i:42`,
  `time-entries-p:web-u:3`); search → `search-<query>-<hash>`

Data stored under the old names is not migrated; rerun the method to write it
under the new name. No `globalArguments` changes.
