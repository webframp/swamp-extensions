## 2026.07.08.1

**Fixed:**

- `unapprove_mr` and `post_review action=request_changes` are now idempotent. GitLab's
  unapprove endpoint returns HTTP 404 when the caller has no approval to remove; that is
  the desired end state for "request changes", not an error. A never-approved MR no longer
  fails the call — the comment still posts and the MR is left unapproved. Non-404 errors
  still propagate.
