## 2026.09.17.1

**Added:** `watch_pr_checks` and `merge_pull_request` methods. `watch_pr_checks`
bounded-polls a PR's status checks to completion and classifies the outcome as
`succeeded`/`failed`. `merge_pull_request` posts an approved merge comment
(e.g. `/shipit`) and bounded-polls until the PR merges or closes. Both are
intended for driving a PR through CI to merge from an automated or
factory-driven workflow.
