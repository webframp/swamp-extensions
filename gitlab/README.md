# @webframp/gitlab

Read and write GitLab data via REST API (v4) and GraphQL. Projects, merge
requests, issues, releases, pipelines, labels, members, branches, and a
cross-project review dashboard with todos. No CLI dependencies — uses native
fetch with a personal access token stored in a swamp vault.

## Prerequisites

- GitLab personal access token with `api` scope
- Token stored in a swamp vault (e.g. `swamp vault set gitlab TOKEN <token>`)

## Installation

```bash
swamp extension pull @webframp/gitlab
```

## Usage

```bash
# Create model with vault-stored token
swamp model create @webframp/gitlab gitlab \
  --global-arg host=git.example.org \
  --global-arg 'token=${{ vault.get("gitlab", "TOKEN") }}'

# Dashboard — cross-project MR overview + todos (GraphQL, single request)
swamp model method run gitlab list_my_merge_requests
swamp model method run gitlab list_my_merge_requests --input role=reviewer
swamp model method run gitlab list_my_merge_requests --input state=merged

# Project-scoped reads (REST)
swamp model method run gitlab list_projects
swamp model method run gitlab get_project_info --input project=group/repo
swamp model method run gitlab list_merge_requests --input project=group/repo
swamp model method run gitlab list_issues --input project=group/repo --input state=closed
swamp model method run gitlab list_releases --input project=group/repo
swamp model method run gitlab list_pipelines --input project=group/repo
swamp model method run gitlab list_issue_notes --input project=group/repo --input iid=42
swamp model method run gitlab list_labels --input project=group/repo
swamp model method run gitlab list_members --input project=group/repo
swamp model method run gitlab list_branches --input project=group/repo

# Search (REST search API)
swamp model method run gitlab search --input query=getUser --input project=group/repo
swamp model method run gitlab search --input query=timeout --input scope=issues --input project=group/repo --input state=opened
swamp model method run gitlab search --input query=api --input scope=projects --input group=group

# Write operations
swamp model method run gitlab create_issue --input project=group/repo --input title="New issue"
swamp model method run gitlab update_issue --input project=group/repo --input iid=1 --input stateEvent=close
swamp model method run gitlab add_issue_note --input project=group/repo --input iid=1 --input body="Comment"
swamp model method run gitlab set_issue_assignees --input project=group/repo --input iid=1 --input usernames='["alice"]'
swamp model method run gitlab unassign_from_issues --input project=group/repo --input iids='[1,2,3]'
swamp model method run gitlab remove_work_item_parent --input project=group/repo --input iid=1
swamp model method run gitlab convert_work_item_type --input project=group/repo --input iid=1 --input type=Issue
swamp model method run gitlab create_merge_request --input project=group/repo --input title="MR" --input sourceBranch=feature
swamp model method run gitlab merge --input project=group/repo --input iid=10
swamp model method run gitlab add_mr_note --input project=group/repo --input iid=10 --input body="Approved"
swamp model method run gitlab create_label --input project=group/repo --input name="priority::high" --input color="#d9534f"
```

## Example Questions for Your Agent

These are things you can ask when this model is available in your workspace:

- "What MRs are waiting for my review?"
- "Show me my full review dashboard"
- "What's assigned to me that's getting stale?"
- "List my open MRs and tell me which ones I should close"
- "What todos do I have pending?"
- "Show me the open merge requests in group/repo"
- "What pipelines ran recently in group/repo?"
- "Create an issue in group/repo titled 'Fix auth timeout'"
- "Close issue #42 in group/repo"
- "Add a comment to MR !15 in group/repo saying the CI is fixed"
- "Who are the members of group/repo?"
- "What labels exist in group/repo?"

## Methods

### Dashboard (GraphQL)

| Method                   | Description                               | Inputs                                                               |
| ------------------------ | ----------------------------------------- | -------------------------------------------------------------------- |
| `list_my_merge_requests` | Cross-project MR overview + pending todos | `role?` (reviewer/assignee/author/all), `state?`, `includeArchived?` |

Uses the GitLab GraphQL API to fetch all three MR views plus todos in a single
request (~55ms vs 4 REST calls at ~287ms). Produces a `dashboard` resource and
fires the `@webframp/review-dashboard` report automatically.

### Read (REST)

| Method                | Description                                                      | Inputs                                         |
| --------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `list_projects`       | Projects for the authenticated user                              | —                                              |
| `get_project_info`    | Detailed info for a project                                      | `project`                                      |
| `list_merge_requests` | MRs for a project                                                | `project`, `state?` (opened/closed/merged/all) |
| `list_issues`         | Issues for a project                                             | `project`, `state?` (opened/closed/all)        |
| `list_releases`       | Releases                                                         | `project`                                      |
| `list_pipelines`      | Recent CI/CD pipelines                                           | `project`                                      |
| `list_issue_notes`    | Comments on an issue                                             | `project`, `iid`                               |
| `list_mr_notes`       | Comments on a merge request                                      | `project`, `iid`                               |
| `list_mr_discussions` | Resolvable MR threads with resolution state + slim diff position | `project`, `iid`, `first?`                     |
| `list_issue_discussions` | Issue discussion threads (not resolvable, unlike MR discussions) | `project`, `iid`, `first?`                  |
| `list_labels`         | Project labels                                                   | `project`                                      |
| `list_members`        | Project members                                                  | `project`                                      |
| `list_branches`       | Repository branches                                              | `project`                                      |
| `get_file`            | Raw file content at a ref, parsed from a pasted blob URL         | `url`                                          |
| `search`              | REST search; scope = blobs (code), commits, issues, merge_requests, notes, wiki_blobs, projects, milestones, snippet_titles, users | `query`, `scope?`, `project?` or `group?`, `ref?`, `state?`, `limit?` |

### Write (REST)

| Method                  | Description                                                       | Inputs                                                               |
| ----------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `create_issue`          | Create an issue                                                   | `project`, `title`, `description?`, `labels?`, `assignees?`, `milestone?`, `dueDate?`, `confidential?`, `weight?` |
| `update_issue`          | Update an issue                                                   | `project`, `iid`, `title?`, `description?`, `labels?`, `addLabels?`, `removeLabels?`, `stateEvent?`, `assignees?`, `milestone?`, `dueDate?`, `confidential?`, `weight?` |
| `add_issue_note`        | Comment on an issue, or reply into a thread                       | `project`, `iid`, `body`, `discussionId?`                            |
| `update_issue_note`     | Edit a comment on an issue                                        | `project`, `iid`, `noteId`, `body`                                   |
| `delete_issue_note`     | Delete a comment on an issue                                      | `project`, `iid`, `noteId`                                           |
| `set_issue_assignees`   | Set (replace) an issue's assignees                                | `project`, `iid`, `usernames`                                        |
| `unassign_from_issues`  | Remove a user (default: you) from multiple issues in one fan-out  | `project`, `iids`, `username?`                                       |
| `remove_work_item_parent` | Detach a work item from its parent (GraphQL)                    | `project`, `iid`                                                     |
| `convert_work_item_type` | Change a work item's type, e.g. Task to Issue (GraphQL)          | `project`, `iid`, `type`                                             |
| `create_merge_request`  | Create a merge request                                            | `project`, `title`, `sourceBranch`, `targetBranch?`, `description?`  |
| `merge`                 | Merge a merge request                                             | `project`, `iid`, `squash?`                                          |
| `add_mr_note`           | Comment on a merge request, or reply into a thread                | `project`, `iid`, `body`, `discussionId?`                            |
| `update_mr_note`        | Edit a comment on a merge request                                 | `project`, `iid`, `noteId`, `body`                                    |
| `delete_mr_note`        | Delete a comment on a merge request                                | `project`, `iid`, `noteId`                                           |
| `resolve_mr_discussion` | Resolve/unresolve an MR discussion thread                         | `project`, `iid`, `discussionId`, `resolved?`                        |
| `set_mr_assignees`      | Set (replace) an MR's assignees                                   | `project`, `iid`, `usernames`                                        |
| `unassign_from_mrs`     | Remove a user (default: you) from multiple MRs in one fan-out     | `project`, `iids`, `username?`                                       |
| `remove_mr_reviewers`   | Remove a reviewer (default: you) from multiple MRs in one fan-out | `project`, `iids`, `username?`                                       |
| `create_label`          | Create a label                                                    | `project`, `name`, `color?`, `description?`                          |

## Reports

### @webframp/review-dashboard

Fires automatically after `list_my_merge_requests`. Renders a prioritized triage
view:

- **🔴 Action Required** — overdue reviews (>7d), stale assignments (>14d), MRs
  to consider closing (>30d)
- **🟡 Aging** — reviews 3-7d old, assignments 7-14d, authored MRs 14-30d
- **🟢 Active** — everything current
- **Todos** — pending GitLab action items (mentions, assignments, CI failures)

## Resources

| Resource          | Description                       | Key fields                                                |
| ----------------- | --------------------------------- | --------------------------------------------------------- |
| **dashboard**     | Cross-project MR overview + todos | username, reviewing, assigned, authored, todos, truncated |
| **projects**      | Project list                      | name, visibility, starCount, archived, truncated          |
| **projectInfo**   | Single project detail             | webUrl, openIssuesCount, topics                           |
| **mergeRequests** | MR list by state                  | iid, author, sourceBranch, draft, truncated               |
| **issues**        | Issue list by state               | iid, author, labels, truncated                            |
| **issueDetail**   | Single issue (from create/update) | iid, webUrl, description, state                           |
| **notes**         | Comments on issue or MR           | noteableType, noteableIid, truncated                      |
| **issueAssignees** | Assignees of an issue after a set/unassign | iid, assignees                                    |
| **issueUnassignResult** | Fan-out unassign result across issues | username, results, failed                            |
| **workItemParent** | Parent of a work item before/after detaching | hadParent, previousParent, parent               |
| **workItemType** | Type of a work item before/after converting | previousType, type                                 |
| **issueDiscussions** | Discussion threads on an issue  | iid, discussions, truncated                               |
| **releases**      | Tagged releases                   | tagName, releasedAt, truncated                            |
| **pipelines**     | CI/CD pipeline runs               | status, source, ref, truncated                            |
| **labels**        | Project labels                    | name, color, description                                  |
| **members**       | Project members                   | username, accessLevel                                     |
| **branches**      | Repository branches               | name, protected, default                                  |
| **fileContent**   | Raw file content at a ref         | project, ref, path, content, truncated                    |
| **searchResults** | Raw GitLab search results         | query, scope, project, group, results, count, truncated   |

### Search scope availability

`search` uses GitLab's REST search API. Without Advanced Search (Elasticsearch
or Zoekt), `blobs`, `commits`, `notes`, and `wiki_blobs` only work in a project
search. An administrator can also disable individual scopes for instance and
group searches, which GitLab reports as `Scope '<scope>' is not available for
this search`. In both cases, set `project` and search each project separately.

## Global Arguments

| Argument | Required | Description                                                  |
| -------- | -------- | ------------------------------------------------------------ |
| `host`   | Yes      | GitLab hostname (e.g. `git.example.org`)                     |
| `token`  | Yes      | Personal access token with `api` scope (use vault reference) |

## Changelog

### v2026.06.12.1

- Added `list_my_merge_requests` method using GitLab GraphQL API
- Added `@webframp/review-dashboard` report extension
- Added `dashboard` resource schema

### v2026.06.10.1

- Replaced `glab` CLI with direct REST API (v4) calls
- Added `token` global argument (required, vault reference)
- All list schemas include `truncated: boolean`

## Troubleshooting

### Single-page results with fixed limits

Most list methods fetch a single page with hardcoded limits: projects (30), MRs
(20), issues (20), releases (10), pipelines (10), notes (50), labels (100),
members (100). The `truncated` field is set from `pageInfo.hasNextPage` so you
can detect incomplete results. Only `list_todos` performs multi-page pagination
(up to 2,000 items).

### Token scope requirements

The `token` global arg needs `api` scope for full functionality. Read-only
operations work with `read_api`, but mutations (create issue, post note, approve
MR) require `api`. A 401 or 403 from GitLab surfaces as a thrown error with the
HTTP status.

### Batch methods report partial failures

`mark_todos_done`, `unassign_from_mrs`, `unassign_from_issues`, and
`remove_mr_reviewers` process items individually. Per-item failures are
recorded in the `failed` array of the output resource without aborting the
batch. Check this field to identify which items could not be processed.

### `set_mr_assignees` / `set_issue_assignees` verify the result

These methods compare the resulting assignee list against the requested list.
If GitLab silently dropped a username (e.g. user does not exist or lacks
project access), the method throws rather than returning a partial
assignment.

### Work item parent and type changes

`remove_work_item_parent` and `convert_work_item_type` use the work-item
GraphQL API, which the REST issues API does not cover. Both check the
mutation response and throw if GitLab did not apply the change.

- A parent the token cannot read (confidential, or in a project the token
  cannot see) is still detected through the hierarchy widget's `hasParent`
  and removed. The resource then records `hadParent: true` with
  `previousParent: null`.
- GitLab enforces hierarchy rules on conversion, and may reject turning a
  Task into an Issue while its parent is an Issue. Run
  `remove_work_item_parent` first.
- `workItemTypes` can list types the instance's tier cannot create, such as
  Epic or Objective on CE. GitLab rejects those conversions, and the error
  is passed through.
- GitLab marks `workItemConvert` as an Experiment, so its behavior may change
  between GitLab releases.

### No retry or rate-limit handling

All HTTP requests fail immediately on non-2xx responses. GitLab rate limits
(429) propagate as thrown errors. For bulk operations, add delays between
invocations.

### Many methods are undocumented in the README

The extension implements ~35 methods but the README documents only a subset. Run
`swamp model type search gitlab` or check the manifest description for the
complete method list.

## License

Apache-2.0 — see LICENSE.md for details.
