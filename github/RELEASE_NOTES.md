## 2026.08.21.2

**Changed:** The `repo` argument on `get_repo_info`, `list_prs`, `list_issues`,
`list_releases`, and `list_workflows` is now validated as an `owner/name` slug up
front; previously an invalid value (missing slash, bare name, extra path
segments) passed schema validation and only failed deep inside the `gh` CLI with
a cryptic error. `gh` command failures now name the exact command that was run
and include its exit code, instead of a bare "gh command failed: ..." message.
A non-JSON response from `gh` (e.g. an unexpected CLI warning printed to
stdout) now raises a clear "returned output that could not be parsed as JSON"
error naming the command, instead of a raw `JSON.parse` `SyntaxError`.

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
