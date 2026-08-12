## 2026.08.12.1

**Added:** `list_my_merge_requests` now includes `pipelineStatus` on each MR in
the dashboard resource. The value is the head pipeline's status normalized to
lowercase (`success`, `failed`, `running`, etc.) or `null` when no pipeline
exists. This enables downstream consumers to make triage decisions based on
pipeline state — for example, auto-approving Renovate MRs with a passing
pipeline.

**Technical details:** The `DASHBOARD_QUERY` GraphQL fragments now request
`headPipeline { status }` on all three MR connection types (reviewing, assigned,
authored). The field is added to `DashboardMRSchema` as
`z.string().nullable().optional()` for backward compatibility with stored data.

**Upgrade note:** Schema is additive only — one new optional nullable field.
Existing stored dashboard resources validate without modification. No
reconfiguration required.

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
