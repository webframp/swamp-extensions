## 2026.08.07.1

**Added:** `post_line_comment` method — posts a comment positioned on a specific
file/line in an MR diff (GitLab REST discussions API), for the standard
diff-level code-review UX that `post_review` (top-level notes only) doesn't
cover. Fetches the MR's current diff versions to build the required
`base_sha`/`start_sha`/`head_sha` position, then creates a positioned
discussion thread. Accepts `newLine` and/or `oldLine` (at least one required)
to comment on added, deleted, or context lines. New `lineComment` resource
records `discussionId`, `noteId`, and the file/line position of each posted
comment, keyed per file/line so multiple comments on the same MR are stored
as separate instances (`lifetime: 30d`, `garbageCollection: 20`, additive —
no changes to existing resources).

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `review.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.

## 2026.07.08.1

**Fixed:**

- `unapprove_mr` and `post_review action=request_changes` are now idempotent. GitLab's
  unapprove endpoint returns HTTP 404 when the caller has no approval to remove; that is
  the desired end state for "request changes", not an error. A never-approved MR no longer
  fails the call — the comment still posts and the MR is left unapproved. Non-404 errors
  still propagate.
