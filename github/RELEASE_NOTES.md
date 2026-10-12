## 2026.10.12.1

**Fixed:** Repeating an `idempotencyKey` on `create_issue`, `add_issue_comment`,
`close_issue`, `retry_workflow_run`, or a finished `merge_pull_request` no
longer fails the workflow step. These methods returned a handle with only a
name when the key had been seen before. The runtime rejected it
(`expected string, received undefined (path: dataId)`), so a scheduled workflow
whose detection persisted reported failure on every run. Dedup itself was
unaffected: no duplicate issue, comment, close, retry, or merge comment was
ever sent.

**Changed:** A repeated key now re-writes the existing `triageAction` record
unchanged and returns its full handle. Each repeat adds a version of that
record (retention is still 20 versions) whose 30-day lifetime starts from the
repeat, so a marker that a workflow keeps hitting stays current instead of
aging out from its first write. No `gh` command runs on a repeat.
