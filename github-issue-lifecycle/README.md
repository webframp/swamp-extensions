# @webframp/github-issue-lifecycle

GitHub issue lifecycle tracker for swamp. Drives issues from open through
triage, planning, implementation, PR linkage, and merge as versioned swamp data.

## Why

Track issue lifecycle phases as queryable, versioned data without leaving the
terminal. Each transition posts a comment and syncs a label on the GitHub issue
(both optional), so the issue thread doubles as an audit log.

## State Machine

```
opened ──[start]──> triaging
triaging ──[triage]──> classified
classified ──[plan]──> planned
planned ──[iterate]──> planned  (feedback loop)
planned ──[approve]──> approved
approved ──[implement]──> implementing
implementing ──[link_pr]──> pr_open
pr_open ──[pr_merged]──> done
pr_open ──[pr_failed]──> pr_failed
pr_failed ──[link_pr]──> pr_open  (retry)
pr_failed ──[implement]──> implementing  (restart)
implementing ──[complete]──> done  (no PR needed)
Any ──[close]──> closed
```

## Setup

```bash
swamp extension pull @webframp/github-issue-lifecycle

# Create a lifecycle tracker scoped to a repo
swamp model create @webframp/github-issue-lifecycle tracker \
  --global repo=webframp/swamp-extensions

# Optionally disable comments or label sync
swamp model create @webframp/github-issue-lifecycle tracker \
  --global repo=webframp/swamp-extensions \
  --global postComments=false \
  --global syncLabels=false
```

## Methods

| Method      | Description                                              |
| ----------- | -------------------------------------------------------- |
| `start`     | Fetch issue context from GitHub and begin tracking       |
| `triage`    | Classify as bug/feature/chore/security/docs, set labels  |
| `plan`      | Record an implementation plan                            |
| `iterate`   | Revise the plan with feedback                            |
| `approve`   | Lock the plan — ready for implementation                 |
| `implement` | Signal implementation started (optionally record branch) |
| `link_pr`   | Associate a PR URL (idempotent)                          |
| `pr_merged` | Record merge, close issue                                |
| `pr_failed` | Record CI/review failure (can retry via link_pr)         |
| `complete`  | Mark done without PR ceremony                            |
| `close`     | Abandon from any state                                   |
| `status`    | Read-only refresh of current issue state                 |

## Querying Lifecycle Data

```bash
# Current state of issue 42
swamp data query tracker 'attributes.issueNumber == 42 && spec == "state"'

# All plans for an issue (history)
swamp data search --model tracker --type resource | \
  jq 'select(.spec == "plan" and .attributes.issueNumber == 42)'

# Issues currently in implementing phase
swamp data query tracker 'spec == "state" && attributes.phase == "implementing"'
```

## Integration with @webframp/github

This model complements `@webframp/github` which provides read-only observation
(list PRs, issues, workflows). The lifecycle model adds write-side transitions
and structured state tracking. Use both together:

```bash
# Observe
swamp model method run github list_issues --input repo=webframp/swamp-extensions

# Pick an issue and start lifecycle
swamp model method run tracker start --input issue_number=42
```

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth login`)
- swamp initialized (`swamp init`)

## Troubleshooting

### Label sync fails silently

All label operations (`syncLabel`) catch errors with an empty catch block. If
your token lacks write permission on labels, or the label does not exist, the
operation silently fails. The state machine advances regardless. No diagnostic
output is produced.

### Comment posting fails hard (unlike label sync)

If `postComments=true` (the default) and the token cannot write comments, the
entire method invocation fails. This asymmetry with label sync means a read-only
token with `postComments=true` will hard-fail every transition. Set
`--global-arg postComments=false` if your token lacks comment-write scope.

### Issue close is best-effort

The `complete`, `close`, and `prMerged` methods attempt to close the GitHub
issue after transitioning state. If the close fails (permissions, network), the
local state records "done"/"closed" but the GitHub issue remains open. No error
is surfaced for this case.

### `start` on an existing issue re-resets to `triaging`

Running `start` again on an issue that already has lifecycle state (and is not
terminal) resets it to `triaging`. In a race condition, this could overwrite
progress made by another process.

### `gh` CLI must be installed and authenticated

All GitHub operations delegate to the `gh` CLI. Authentication state is
inherited from `gh auth login`. There is no in-extension token configuration.

## Development

```bash
cd github-issue-lifecycle
deno task check
deno task lint
deno task fmt
deno task test
```
