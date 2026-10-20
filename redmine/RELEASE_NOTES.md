## 2026.10.20.1

**Added:** `list_attachments` lists the attachments of an issue (ID, file name,
size, content type, author, date) into a new `attachments` resource, named
`attachments-<issueId>`. `download_attachments` downloads them in one run into a
new `attachment` file spec, named `attachment-<issueId>-<attachmentId>`. It
filters by attachment IDs or a content-type prefix (case-insensitive) and skips
files over `maxBytes` (default 20 MiB). Until now the type had no way to read an
attachment.

The `attachments` resource always lists every attachment of the issue, with a
status (`downloaded`, `not-selected`, `skipped-too-large` or `failed` with an
`error`) and, for downloaded ones, the `dataName` of the stored file. `filter`
records the selection and `maxBytes`. The size limit applies to the bytes
Redmine serves as well as to the size it records. A non-HTML attachment served
as an HTML page (a login or proxy error page) is `failed`, not stored. If any
download fails, the method stores the files that did download and the resource,
then fails the run naming each failed attachment.

**Fixed:** Every request sent `X-Redmine-API-Key` and `X-Redmine-Username` to
whatever host a redirect pointed at, because `fetch` strips only `Authorization`
on a cross-origin redirect.

**Fixed:** Methods overwrote each other's stored data. Swamp stores data by
name, not by spec, so `list_statuses`, `list_trackers`, `list_projects` and
`list_custom_fields` all wrote `all`, and `get_issue` and `list_relations` both
wrote the bare issue ID. Every data name now carries a spec prefix (see
**Upgrade note**).

**Fixed:** The source files' SPDX header said AGPL-3.0-or-later; it now says
Apache-2.0, matching `LICENSE.md` and the manifest.

**Changed:** A redirect to another origin now fails an API call with a message
naming the URL to set as `host`. A same-origin redirect, or an http→https
upgrade of the same host, still works. `download_attachments` follows other
redirects without the credentials (S3 or CDN storage backends).

**Changed:** A POST (`create_issue`, `create_version`, `upload_file`, ...)
retries only a 429. A 502 or 504 can arrive after Redmine already created the
record, and retrying it created a duplicate. GET, PUT and DELETE still retry
429/502/503/504. `upload_file`'s upload now uses the same retry and redirect
handling as every other call.

**Changed:** Requests no longer wait forever on a server that stops answering.
JSON requests time out after 120 seconds per attempt, downloads after 60 seconds
without data, and `upload_file`'s upload after 10 minutes per attempt.

**Upgrade note:** Data names change. Update any `data.latest(...)` or
`model.<name>.resource.<spec>.<name>` reference:

- `all` → `statuses-all`, `trackers-all`, `projects-all`, `custom-fields-all`
- `<project>` → `users-<project>`, `versions-<project>`,
  `issue-categories-<project>`
- `<filters>` → `issues-<filters>`; `<issueId>` → `issue-<issueId>`,
  `relations-<issueId>`; `<versionId>` → `version-<versionId>`
- time entries → `time-entries-<...>`; search → `search-<query>`

Data stored under the old names is not migrated; rerun the method to write it
under the new name. No `globalArguments` changes.
