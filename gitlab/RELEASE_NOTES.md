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
