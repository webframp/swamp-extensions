## 2026.06.26.1

**Added:** `approvedByMe` (boolean) and `myReviewState` (pending/reviewed/approved/unapproved, nullable) fields on every MR in `list_my_merge_requests` output. Consumers can now filter actionable reviews from already-handled ones without additional API calls.

**Changed:** The GraphQL query now fetches `approvedBy` and `reviewers` with `mergeRequestInteraction` on all three MR lists (reviewer, assigned, authored). This adds ~200 bytes per MR to the response but no additional API round-trips. The `assigned` and `authored` lists now also populate the `commented` field (previously always `false` due to missing `currentUser` param).

**Upgrade note:** Schema is additive only. Existing model instances work without reconfiguration. Previously stored dashboard resources will be overwritten on next method call.
