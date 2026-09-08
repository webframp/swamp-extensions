## 2026.09.08.2

**Added:** `get_file` method — fetches a file's raw content at a given ref
via the REST `repository/files/:path/raw` endpoint. Accepts a GitLab blob URL
(e.g. `https://<host>/<group>/<project>/-/blob/<ref>/<path>`, the kind you'd
paste from the web UI) and resolves `project`, `ref`, and `path` from it. A
ref containing slashes (e.g. `feat/my-feature`) is disambiguated by probing
the API for each plausible ref/path split, rather than guessing the first
one. The URL's host must match the model instance's configured `host`,
tolerating an explicit default port (`:443`) — a URL for a different GitLab
instance is rejected. If more than one ref/path split resolves (e.g. a
branch and a tag sharing a slash-containing name), a warning is logged and
the shortest-ref candidate is used; probing is bounded to 10 splits so a
pathologically deep path can't force an unbounded burst of API calls, and
a non-404 error on one candidate (e.g. GitLab rejecting a malformed ref)
no longer aborts the whole call — later candidates still get a chance to
resolve. Writes a new `fileContent` resource,
with a collision-resistant instance name (hashed project/ref/path) so
distinct files with hyphenated components can't overwrite each other.
Only text/code files are supported — binary content (images, archives,
compiled artifacts) is detected by sniffing for a NUL byte, the same
heuristic Git itself uses, rather than trusting `Content-Type` alone
(GitLab's raw-file endpoint commonly serves extension-less text files
like `Dockerfile` or `Jenkinsfile` as `application/octet-stream`). If a
resolved candidate turns out to be binary while a different ref/path
split resolves as text, that candidate is skipped and a warning notes it
so the mismatch isn't silent — and if every candidate is either binary or
missing, the binary rejection is what surfaces (it means the target file
was found, just of an unsupported type), not a less useful later error.
The response body is read up to the size cap and the rest of the stream
is discarded, so an oversized file (a multi-GB vendored bundle, a SQL
dump) is never fully buffered into memory before being trimmed down.
Content is capped at 500KB measured in bytes (not JS string length),
truncating on a UTF-8 codepoint boundary so a multi-byte character
straddling the cap isn't corrupted into a replacement character, and
common credential patterns are redacted, same as `get_job_log`'s trace
handling.

**Upgrade note:** no schema or globalArguments change for existing resources.
Running any method on an existing instance migrates it to `2026.09.08.2` as a
no-op.

## 2026.09.08.1

**Fixed:** the manifest description's method list (published to the registry
and README) was missing seven methods that already shipped in code:
`list_commits`, `get_issue`, `list_mr_discussions`, `resolve_mr_discussion`,
`set_mr_reviewers`, `remove_mr_reviewers`, and `unassign_from_mrs`. Users
browsing the registry entry had no way to discover these without reading
source. No behavioral change — documentation only.

**Upgrade note:** no schema or globalArguments change. Running any method on
an existing instance migrates it to `2026.09.08.1` as a no-op.

## 2026.09.02.1

**Added:** `get_issue` method — fetches a single issue by `project` and `iid`,
including its `description` body, via GraphQL `project.issue(iid)`. Writes the
existing `issueDetail` resource (the same shape produced by `create_issue` and
`update_issue`). Enables reading full work-item details, such as a directly
addressed tier-1 to-do, without creating or mutating the issue.

**Fixed:** the `2026.07.30.1` upgrade erroneously injected `sourceBranch`,
`targetBranch`, and `webUrl` into `globalArguments` (only `host` and `token`
are valid), which broke **every** method on upgraded instances with an
`Unknown argument(s)` validation error. That upgrade is now a no-op on global
arguments (the `mergeStatus` fields it described belong to a resource schema,
which needs no attribute migration), and the `2026.09.02.1` upgrade removes the
stray keys from any instance already poisoned by it.

**Upgrade note:** running any method on an existing instance migrates it to
`2026.09.02.1` and strips the stray global-argument keys automatically. No
manual intervention is required.

## 2026.09.01.1

**Added:** `mergedAt` field on merge requests (GraphQL `mergedAt`, REST
`merged_at`) — the timestamp an MR was merged, or `null` if not merged.

**Added:** `approvers` field on merge requests — the usernames who approved
(reviewed) the MR, from GraphQL `approvedBy`. Enables cross-boundary review
attribution (an approver helps the MR author). REST-mapped MRs default to an
empty array.

**Added:** `list_commits` method — lists a project's commits (optionally a
branch, with a `since` lower time bound) via the REST `repository/commits`
endpoint, writing a `commits` resource. Enables commit-based contribution
analysis (who commits to another crew's repository).

Together these support downstream review-outcome / unblock-rate scoring and
cross-boundary contribution measurement.

**Upgrade note:** Purely additive and backward-compatible. New MR fields are
nullable / defaulted, so merge-request data stored by earlier versions still
validates on read. `list_commits` is a new method; no existing method changed.

## 2026.08.28.1

**Changed:** Normalized the extension license to Apache-2.0 and corrected the
copyright holder to "Sean Escriva". Extensions that previously shipped an MIT
LICENSE.md are now Apache-2.0, consistent with the repository root and every
other extension. No code or behavioral changes.

**Upgrade note:** License text only. No API, schema, or runtime behavior
changed.

## 2026.08.26.3

**Fixed:** Restored inline `npm:zod@4.4.3` import specifiers so the registry
quality scorer can resolve dependencies and score the extension. An earlier
release used a bare `"zod"` import-map specifier, which published but scored as
unscored.

**Changed:** Retained explicit `compilerOptions.strict` in `deno.json`. No
behavioral or schema changes.
