## 2026.07.30.1

**Fixed:** `list_merge_requests` and `list_issues` fail with "Variable $state
of type MergeRequestState was provided invalid value" when any state filter is
used. The methods incorrectly uppercased the state value before passing it to
the GitLab GraphQL API, which expects lowercase enum values (`opened`, `closed`,
`merged`). The `list_my_merge_requests` dashboard query was unaffected because
it already passed the value without transformation.

**Added:** `get_merge_request` now returns `sourceBranch`, `targetBranch`, and
`webUrl` in the `mergeStatus` resource. Previously these fields required a
heavier call through `@webframp/gitlab-review` / `get_mr_diff`. Consumers
composing with git-workspace or other models that need the source branch can now
get it directly from the merge status check.

**Upgrade note:** Schema is additive only — three new nullable fields. Existing
stored `mergeStatus` resources will be backfilled with `null` values on upgrade.
No reconfiguration required.
