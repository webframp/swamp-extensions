## 2026.10.21.1

**Added:** `post_discussion` opens a general resolvable thread on a merge
request, with no diff position. Use it for review points that don't sit on a
changed line, such as a stale doc outside the diff or a commit-type nit. Before
this, those points could only go into the single `post_review` note, which
GitLab does not let anyone resolve. Arguments are `project`, `iid` and `body`.
Like the other posting methods, it refuses a closed or merged MR (run
`get_mr_diff` first).

**Added:** `discussionThread` resource records each thread (`discussionId`,
`noteId`, `body`, `postedAt`). Instances are keyed by a SHA-256 prefix of the
body, and `post_discussion` skips posting when the same body is already recorded
for that MR, so a retry after a successful post does not open a duplicate
thread. The body is compared after normalising line endings and trimming
trailing whitespace.

**Upgrade note:** Additive only. Existing resources and methods are unchanged.
