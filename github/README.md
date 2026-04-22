# @webframp/github

A swamp model extension for querying GitHub repository data using the `gh` CLI. This extension provides methods to list repositories, inspect repository details, enumerate pull requests, issues, releases, and recent workflow runs -- all without leaving the swamp workflow.

## Prerequisites

- [gh CLI](https://cli.github.com/) installed and available on your `PATH`
- Authenticated via `gh auth login` (token or browser-based flow)

## Installation

```bash
swamp extension pull @webframp/github
```

## Model Creation

Create a GitHub model instance to start querying data:

```bash
swamp model create @webframp/github github
```

## Method Execution Examples

List your repositories (up to 30):

```bash
swamp model method run github list_repos
```

Get detailed information about a specific repository:

```bash
swamp model method run github get_repo_info --input repo=octocat/Hello-World
```

List open pull requests for a repository:

```bash
swamp model method run github list_prs --input repo=octocat/Hello-World
```

List closed issues:

```bash
swamp model method run github list_issues --input repo=octocat/Hello-World --input state=closed
```

List releases:

```bash
swamp model method run github list_releases --input repo=octocat/Hello-World
```

List recent workflow runs:

```bash
swamp model method run github list_workflows --input repo=octocat/Hello-World
```

## Available Methods

| Method | Description |
|--------|-------------|
| `list_repos` | List repositories for the authenticated user with basic metadata |
| `get_repo_info` | Get detailed information about a specific repository |
| `list_prs` | List pull requests for a repository with optional state filter |
| `list_issues` | List issues for a repository with optional state filter |
| `list_releases` | List releases for a repository |
| `list_workflows` | List recent workflow runs for a repository |

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
