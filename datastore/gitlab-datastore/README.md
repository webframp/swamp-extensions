# @webframp/gitlab-datastore

A swamp datastore extension that stores runtime data in GitLab using the
Terraform state HTTP API. This extension provides distributed locking through
GitLab's native state locking mechanism and supports bidirectional sync between
a local cache and GitLab-hosted state.

Data is wrapped in a Terraform state envelope so that GitLab treats each piece
of swamp data as a first-class Terraform state object. The extension encodes
file paths into state names, handles serial-number management automatically, and
detects stale locks to recover from crashes.

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
    projectId: "12345" # numeric ID or "group/project"
    baseUrl: "https://gitlab.com" # optional, defaults to gitlab.com
    token: "glpat-xxxxxxxxxxxxxxxxxxxx" # API-scoped personal access token
    username: "my-user" # optional
    statePrefix: "swamp" # optional namespace prefix
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

- **createLock** -- acquire and release distributed locks via GitLab state
  locking
- **createVerifier** -- run a health check against the GitLab API
- **createSyncService** -- pull and push changed files between local cache and
  GitLab
- **resolveDatastorePath / resolveCachePath** -- resolve the local cache
  directory

## Observability

The extension emits [OpenTelemetry](https://opentelemetry.io/) spans for GitLab
API calls, lock acquisition/release, and push/pull sync. It depends on
`@opentelemetry/api` only — the host process owns the `TracerProvider`, so every
span is a no-op when none is registered. When swamp runs with OTel enabled,
datastore activity appears in traces nested under swamp's own
`swamp.datastore.*` spans.

Three layers are instrumented:

- **API calls** — every request passes through one choke point, so each round
  trip emits exactly one span (`GitLab getState`, `GitLab putState`,
  `GitLab readStateSerial`, `GitLab listStates`, `GitLab getProject`,
  `GitLab lock`, `GitLab unlock`, `GitLab getLockInfo`, `GitLab deleteState`,
  `GitLab healthCheck`) with `http.request.method`,
  `http.response.status_code`, `gitlab.project_id`, `gitlab.state_name`, and
  `server.address`.
- **Lock** — `gitlab-datastore lock acquire` / `release` / `withLock` /
  `inspect` / `forceRelease`. Acquire records `lock.wait_duration_ms`,
  `lock.contended`, and `lock.holder`.
- **Sync** — `gitlab-datastore pullChanged` / `pushChanged` / `hydrateFile` /
  `preparePush` / `commitPush`, with `datastore.files_pulled`,
  `datastore.files_pushed`, `datastore.states`, and
  `datastore.fast_path_hit`.

Non-2xx responses mark their span as an error, except where the status is normal
control flow: a 404 from `getState` means the state does not exist, a 409 or 423
from `lock` means another holder has it, and a 404 or 204 from `getLockInfo`
means the state is unlocked. Lock retries appear as `retry` events with
`retry.reason` set to either `lock_contended` or `stale_lock_stolen`.

The access token is never recorded. Every request carries a PRIVATE-TOKEN header
and bodies carry file content; span attributes hold only the operation name,
HTTP method, status, project ID, state name, and host.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
