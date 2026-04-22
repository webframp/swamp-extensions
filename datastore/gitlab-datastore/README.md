# @webframp/gitlab-datastore

A swamp datastore extension that stores runtime data in GitLab using the
Terraform state HTTP API. This extension provides distributed locking through
GitLab's native state locking mechanism and supports bidirectional sync between
a local cache and GitLab-hosted state.

Data is wrapped in a Terraform state envelope so that GitLab treats each piece
of swamp data as a first-class Terraform state object. The extension encodes
file paths into state names, handles serial-number management automatically,
and detects stale locks to recover from crashes.

## Prerequisites

- A GitLab project with API access (GitLab.com or self-hosted)
- A personal access token (or CI job token) with the `api` scope
- The project ID (numeric) or URL-encoded path (e.g., `mygroup/myproject`)

## Installation

```bash
swamp extension pull @webframp/gitlab-datastore
```

## Configuration

Add a datastore block to your workspace or repo configuration that points to
this extension and supplies the required credentials.

```yaml
datastore:
  type: "@webframp/gitlab-datastore"
  config:
    projectId: "12345"                          # numeric ID or "group/project"
    baseUrl: "https://gitlab.com"               # optional, defaults to gitlab.com
    token: "glpat-xxxxxxxxxxxxxxxxxxxx"         # API-scoped personal access token
    username: "my-user"                         # optional
    statePrefix: "swamp"                        # optional namespace prefix
```

## Usage

Once the datastore is configured, swamp operations that require persistent
storage or distributed locking will use GitLab automatically.

```bash
# Verify connectivity and health
swamp datastore verify

# Pull remote state into the local cache
swamp datastore pull

# Push local changes back to GitLab
swamp datastore push
```

The extension exposes the standard swamp datastore provider interface:

- **createLock** -- acquire and release distributed locks via GitLab state locking
- **createVerifier** -- run a health check against the GitLab API
- **createSyncService** -- pull and push changed files between local cache and GitLab
- **resolveDatastorePath / resolveCachePath** -- resolve the local cache directory

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
