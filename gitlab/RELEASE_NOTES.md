## 2026.09.20.2

**Added:** Issue management brought to parity with merge requests, closing
GitHub issue #412:

- `set_issue_assignees` — set (replace) an issue's assignees by username;
  pass an empty list to unassign. Mirrors `set_mr_assignees`: GitLab CE keeps
  one assignee, EE/Premium support multiple, and the method throws loudly if
  GitLab silently drops a requested username.
- `unassign_from_issues` — remove an assignee (default: the authenticated
  user) from multiple issues in a project in one fan-out. Mirrors
  `unassign_from_mrs`: uses `operationMode: REMOVE` so co-assignees are
  preserved, is idempotent, and isolates per-issue failures into a `failed`
  array without aborting the batch.
- `update_issue_note` / `delete_issue_note` — edit or remove an issue comment
  by note id. Mirrors `update_mr_note`/`delete_mr_note`, including the
  "note not found or permission denied" error on GitLab's null-payload path.
- `list_issue_discussions` — list discussion threads on an issue, with the
  same hoisted resolution/location/author fields and slim diff position as
  `list_mr_discussions`. GitLab does not support resolving plain issue
  discussions (only MR/diff discussions), so there is no
  `resolve_issue_discussion` method — `resolvable`/`resolved` simply read
  `false` for issue threads.
- `create_issue` and `update_issue` now accept optional `assignees`
  (usernames), `milestone` (numeric id or a title resolved via the GitLab
  API), `dueDate`, `confidential`, and `weight` (GitLab EE). `update_issue`
  additionally accepts `addLabels`/`removeLabels` for incremental label
  changes alongside the existing wholesale `labels` replacement, so callers
  can adjust labels without a read-modify-write race.
- `add_issue_note` now accepts an optional `discussionId` to reply into an
  existing thread (from `list_issue_discussions`), mirroring `add_mr_note`.

**Changed:** None of the above are breaking — every new argument is optional
and every new method is additive. Existing calls to `create_issue`,
`update_issue`, and `add_issue_note` behave exactly as before when the new
arguments are omitted.

**Upgrade note:** No co-upgrades required. New resources `issueAssignees`,
`issueUnassignResult`, and `issueDiscussions` are additive; no
`globalArguments` change.
