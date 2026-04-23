# @webframp/gitlab

Query GitLab data using the `glab` CLI for project, merge request, issue,
release, and pipeline visibility. Supports self-hosted GitLab instances
through the `host` global argument.

## Prerequisites

- [glab CLI](https://gitlab.com/gitlab-org/cli) installed and authenticated
  (`glab auth login`)

## Installation

```bash
swamp extension pull @webframp/gitlab
```

## Usage

```bash
# Create model (uses glab's default host)
swamp model create @webframp/gitlab gitlab

# Or target a self-hosted instance
swamp model create @webframp/gitlab gitlab --global-arg host=git.example.org

# List your projects
swamp model method run gitlab list_projects

# Get project details
swamp model method run gitlab get_project_info --input project=group/repo

# List open merge requests
swamp model method run gitlab list_merge_requests --input project=group/repo

# List closed issues
swamp model method run gitlab list_issues --input project=group/repo --input state=closed

# List releases
swamp model method run gitlab list_releases --input project=group/repo

# List recent CI/CD pipelines
swamp model method run gitlab list_pipelines --input project=group/repo
```

## Methods

| Method | Description | Inputs |
|--------|-------------|--------|
| `list_projects` | List projects for the authenticated user | — |
| `get_project_info` | Detailed info for a specific project | `project` |
| `list_merge_requests` | List merge requests | `project`, `state?` |
| `list_issues` | List issues | `project`, `state?` |
| `list_releases` | List releases | `project` |
| `list_pipelines` | List recent CI/CD pipelines | `project` |

## Resources

- **projects** — project list with metadata (stars, forks, visibility, topics)
- **mergeRequests** — MRs with author, reviewer, labels, and CI status
- **issues** — issues with assignee, labels, and timestamps
- **releases** — tagged releases with descriptions
- **pipelines** — recent pipeline runs with status, ref, and duration

## License

Apache-2.0 — see LICENSE.md for details.
