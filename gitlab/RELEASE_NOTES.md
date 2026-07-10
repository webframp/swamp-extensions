## 2026.07.10.2

**Added:** A canonical, GitLab-flavored `reference` on every dashboard work item
from `list_my_merge_requests` — `group/project!123` for MRs, `group/project#123`
for issue todos — so items in a cross-project list are uniquely identifiable and
autolink in GitLab markdown. MRs derive it from the project path + iid; todos
parse it (and a new `iid`) from `targetUrl` (the todo's own `project` field is a
display name, not a path). The `@webframp/review-dashboard` report now renders
these references, unfenced, in the MR tables and the todos table (falling back
to the project path / target type for data written before this release).

## 2026.07.10.1

**Added:** `unassign_from_mrs(project, iids, username?)` — remove an assignee
(default: the authenticated user) from multiple MRs in a single fan-out call.
Uses GraphQL `mergeRequestSetAssignees` with `operationMode: REMOVE`, so other
assignees are preserved; it is idempotent, and per-MR failures are recorded in a
`failed[]` list rather than aborting the batch. Complements `set_mr_assignees`
(REPLACE, single MR) for the common "clear my review queue" case without a
read-modify-write. Writes a new `unassignResult` resource.

## 2026.07.08.4

**Added:** MR note management and assignee control.

- `update_mr_note(project, iid, noteId, body)` — edit an MR comment by id
  (GraphQL `updateNote`).
- `delete_mr_note(project, iid, noteId)` — remove an MR comment by id (GraphQL
  `destroyNote`). Previously a comment could be created but not deleted in-model.
- `set_mr_assignees(project, iid, usernames)` — set/replace assignees by
  username (GraphQL `mergeRequestSetAssignees`, `operationMode: REPLACE`); pass
  an empty list to unassign. GitLab CE keeps a single assignee; EE/Premium
  support multiple.

## 2026.07.08.3

**Added:** CI-failure diagnosis for merge requests.

- `get_pipeline_jobs(project, pipelineId, scope=failed)` — list a pipeline's jobs
  with GitLab's `failure_reason`, so a caller can tell a transient failure
  (`runner_system_failure`, `stuck_or_timeout_failure`, `job_execution_timeout`,
  `api_failure`) from a real one (`script_failure`).
- `get_job_log(project, jobId, tailLines=200)` — the tail of a job's trace, to
  diagnose why it failed (never the whole log).
- `retry_job(project, jobId)` / `retry_pipeline(project, pipelineId)` — re-run CI
  after a transient failure.
- `get_merge_request` now also returns `headPipelineId`, so you can go straight
  from a blocked MR to its failed jobs.

## 2026.07.08.2

**Added:**

- `get_merge_request` — report an MR's mergeability via GitLab's
  `detailed_merge_status`, with a plain-English `summary` and `blockers` list
  (answers "why can't this MR merge?": need_rebase, conflict, ci_must_pass,
  not_approved, discussions_not_resolved, draft, …).
- `rebase_merge_request` — trigger a rebase of an MR's source branch onto its
  target (REST), polling until it finishes (`rebased`), errors (`error` with
  `merge_error`), or is still running (`in_progress`). Supports `skipCi`.

## 2026.07.08.1

**Added:**

- `list_mr_notes` — list the discussion notes/comments on a merge request (mirrors
  `list_issue_notes`; writes the shared `notes` resource with `noteableType: "merge_request"`).
- `mark_todo_done` — mark a GitLab to-do as done via the `todoMarkDone` mutation, so
  handled items drop off the pending queue. Accepts either the `gid://gitlab/Todo/NNN`
  form or a bare numeric id.

## 2026.06.26.1

**Added:** `approvedByMe` (boolean) and `myReviewState` (pending/reviewed/approved/unapproved, nullable) fields on every MR in `list_my_merge_requests` output. Consumers can now filter actionable reviews from already-handled ones without additional API calls.

**Changed:** The GraphQL query now fetches `approvedBy` and `reviewers` with `mergeRequestInteraction` on all three MR lists (reviewer, assigned, authored). This adds ~200 bytes per MR to the response but no additional API round-trips. The `assigned` and `authored` lists now also populate the `commented` field (previously always `false` due to missing `currentUser` param).

**Upgrade note:** Schema is additive only. Existing model instances work without reconfiguration. Previously stored dashboard resources will be overwritten on next method call.
