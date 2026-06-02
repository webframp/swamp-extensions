# @webframp/artifactory

Query and monitor JFrog Artifactory from a package consumer perspective.
AQL-powered package search, repository health fan-out, service health
monitoring, and diff detection for tracking package changes over time.

## Authentication

Uses a JFrog Identity Token or Access Token stored in a swamp vault.

```bash
# Store token in vault
swamp vault put my-vault artifactory-token "eyJ..."

# Create model
swamp model create @webframp/artifactory packages \
  --global-arg url=https://packages.example.com \
  --global-arg 'token=vault://my-vault/artifactory-token'
```

## Methods

| Method | Description |
|--------|-------------|
| `system_health` | Ping + best-effort health details (graceful on 403) |
| `list_repos` | List all repositories with type and package type |
| `get_repo_health` | Per-repo artifact count and storage (fan-out or single) |
| `query_packages` | AQL query with limit, results keyed by query hash |
| `diff_packages` | Compare current vs previous for the same AQL query |
| `get_storage_info` | Global storage summary (may require admin) |

## Usage

```bash
# Check service health
swamp model method run packages system_health

# List all repositories
swamp model method run packages list_repos

# Check health of all repos (fan-out)
swamp model method run packages get_repo_health

# Check single repo
swamp model method run packages get_repo_health --input repoKey=docker-local

# Query packages via AQL
swamp model method run packages query_packages \
  --input 'query=items.find({"repo":"npm-local","name":{"$match":"lodash*"}})'

# Detect package changes since last run
swamp model method run packages diff_packages \
  --input 'query=items.find({"repo":"npm-local"})'

# Storage overview
swamp model method run packages get_storage_info
```

## Design

- **Factory pattern**: One model per Artifactory server. `get_repo_health`
  produces one data artifact per repository. Data accumulates per-repo.
- **AQL queries keyed by hash**: Each unique query gets its own diff history
  via FNV-1a hash of the query string.
- **Graceful degradation**: Non-admin tokens get ping and repo list. Admin
  endpoints (health details, storage info) return partial data with 403 note
  rather than failing the entire method.
- **Truncation tracking**: All list outputs include `truncated: boolean`.

## License

Apache-2.0
