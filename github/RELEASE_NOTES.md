## 2026.08.21.1

**Changed:** Added `.describe()` documentation to every previously undocumented field in the
resource schemas (`RepoSchema`, `RepoListSchema`, `RepoInfoSchema`, `PullRequestSchema`,
`PullRequestListSchema`, `IssueSchema`, `IssueListSchema`, `ReleaseSchema`, `ReleaseListSchema`,
`WorkflowRunSchema`, `WorkflowRunListSchema`). No schema or behavioral changes — a no-op
`upgrades` entry was added to keep the model's `typeVersion` tracking in sync with the version bump.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `repos.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.

## 2026.07.16.1

**Changed:** README and LICENSE reformatted (deno fmt) in PR #134; this is the first version bump to publish that formatting to the registry. No functional or behavioral change.
