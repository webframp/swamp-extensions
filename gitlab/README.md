# @webframp/gitlab

Read and write GitLab data via the REST API (v4). Projects, merge requests,
issues, releases, pipelines, labels, members, and branches. No CLI
dependencies — uses native fetch with a personal access token stored in a
swamp vault.

## Breaking Changes (v2026.06.10.1)

This version replaces the `glab` CLI with direct REST API calls:

- **Removed:** `glab` CLI dependency
- **Added:** `token` global argument (required) — use a vault reference
- **Changed:** `host` global argument is now required (no default)
- **Changed:** All list resource schemas now include `truncated: boolean`

Existing model instances must be recreated with the new `token` argument.

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
  --global-arg host=git.bethelservice.org \
  --global-arg 'token=${{ vault.get("gitlab", "TOKEN") }}'

# Read operations
swamp model method run gitlab list_projects
swamp model method run gitlab get_project_info --input project=group/repo
swamp model method run gitlab list_merge_requests --input project=group/repo
swamp model method run gitlab list_issues --input project=group/repo --input state=closed
swamp model method run gitlab list_releases --input project=group/repo
swamp model method run gitlab list_pipelines --input project=group/repo
swamp model method run gitlab list_issue_notes --input project=group/repo --input iid=42

# Write operations
swamp model method run gitlab create_issue --input project=group/repo --input title="New issue"
swamp model method run gitlab update_issue --input project=group/repo --input iid=1 --input stateEvent=close
swamp model method run gitlab add_issue_note --input project=group/repo --input iid=1 --input body="Comment"
swamp model method run gitlab create_merge_request --input project=group/repo --input title="MR" --input sourceBranch=feature
swamp model method run gitlab merge --input project=group/repo --input iid=10
swamp model method run gitlab add_mr_note --input project=group/repo --input iid=10 --input body="LGTM"
swamp model method run gitlab create_label --input project=group/repo --input name="priority::high" --input color="#d9534f"
swamp model method run gitlab list_labels --input project=group/repo
swamp model method run gitlab list_members --input project=group/repo
swamp model method run gitlab list_branches --input project=group/repo
```

## Methods

### Read

| Method | Description | Inputs |
|--------|-------------|--------|
| `list_projects` | List projects for the authenticated user | — |
| `get_project_info` | Detailed info for a specific project | `project` |
| `list_merge_requests` | List merge requests | `project`, `state?` (opened/closed/merged/all) |
| `list_issues` | List issues | `project`, `state?` (opened/closed/all) |
| `list_releases` | List releases | `project` |
| `list_pipelines` | List recent CI/CD pipelines | `project` |
| `list_issue_notes` | List comments on an issue | `project`, `iid` |
| `list_labels` | List project labels | `project` |
| `list_members` | List project members | `project` |
| `list_branches` | List repository branches | `project` |

### Write

| Method | Description | Inputs |
|--------|-------------|--------|
| `create_issue` | Create an issue | `project`, `title`, `description?`, `labels?` |
| `update_issue` | Update an issue | `project`, `iid`, `title?`, `description?`, `labels?`, `stateEvent?` |
| `add_issue_note` | Comment on an issue | `project`, `iid`, `body` |
| `create_merge_request` | Create a merge request | `project`, `title`, `sourceBranch`, `targetBranch?`, `description?` |
| `merge` | Merge a merge request | `project`, `iid`, `squash?` |
| `add_mr_note` | Comment on a merge request | `project`, `iid`, `body` |
| `create_label` | Create a label | `project`, `name`, `color?`, `description?` |

## Resources

| Resource | Description | Key fields |
|----------|-------------|------------|
| **projects** | Project list | name, visibility, starCount, archived, truncated |
| **projectInfo** | Single project detail | webUrl, openIssuesCount, topics |
| **mergeRequests** | MR list by state | iid, author, sourceBranch, draft, truncated |
| **issues** | Issue list by state | iid, author, labels, truncated |
| **issueDetail** | Single issue (from create/update) | iid, webUrl, description, state |
| **notes** | Comments on issue or MR | noteableType, noteableIid, truncated |
| **releases** | Tagged releases | tagName, releasedAt, truncated |
| **pipelines** | CI/CD pipeline runs | status, source, ref, truncated |
| **labels** | Project labels | name, color, description |
| **members** | Project members | username, accessLevel |
| **branches** | Repository branches | name, protected, default |

## Global Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `host` | Yes | GitLab hostname (e.g. `git.bethelservice.org`) |
| `token` | Yes | Personal access token with `api` scope (use vault reference) |

## License

Apache-2.0 — see LICENSE.md for details.
