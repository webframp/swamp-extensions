## 2026.07.30.1

**Fixed:** `list_merge_requests` and `list_issues` fail with "Variable $state
of type MergeRequestState was provided invalid value" when any state filter is
used. The methods incorrectly uppercased the state value before passing it to
the GitLab GraphQL API, which expects lowercase enum values (`opened`, `closed`,
`merged`). The `list_my_merge_requests` dashboard query was unaffected because
it already passed the value without transformation.
