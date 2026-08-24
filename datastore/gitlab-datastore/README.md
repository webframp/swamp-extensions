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
  `GitLab healthCheck`) with `http.request.method`, `http.response.status_code`,
  `gitlab.project_id`, `gitlab.state_name`, and `server.address`.
- **Lock** — `gitlab-datastore lock acquire` / `release` / `withLock` /
  `inspect` / `forceRelease`. Acquire records `lock.wait_duration_ms`,
  `lock.contended`, and `lock.holder`.
- **Sync** — `gitlab-datastore pullChanged` / `pushChanged` / `hydrateFile` /
  `preparePush` / `commitPush`, with `datastore.files_pulled`,
  `datastore.files_pushed`, `datastore.states`, and `datastore.fast_path_hit`.

Non-2xx responses mark their span as an error, except where the status is normal
control flow: a 404 from `getState` means the state does not exist, a 409 or 423
from `lock` means another holder has it, and a 404 or 204 from `getLockInfo`
means the state is unlocked. Retries appear as `retry` events with
`retry.reason` set to `lock_contended`, `stale_lock_stolen`, or — for a `429`
rate-limited API call — `rate_limited`. Rate-limited calls retry up to 5 times,
honoring the `Retry-After` header when GitLab sends one and otherwise backing
off exponentially, before the call is allowed to fail.

The access token is never recorded. Every request carries a PRIVATE-TOKEN header
and bodies carry file content; span attributes hold only the operation name,
HTTP method, status, project ID, state name, and host.

## Troubleshooting

### Lock stolen after ~60 seconds

Locks older than `staleLockThresholdMs` (60s default) are considered stale and
force-released by competing processes. If your model method takes longer than 60
seconds, the lock may be stolen without notification. The heartbeat updates
local metadata only — it does not refresh the lock in GitLab.

### Files larger than 4MB silently skipped during push

GitLab's state API has a per-state size limit. Files exceeding 4MB are silently
omitted from push operations. No warning is logged. If model outputs routinely
exceed this, consider a different datastore backend.

### 429 rate limit retry (up to 5 attempts)

All API calls retry on 429 responses with exponential backoff (1s base,
doubling, max 30s). The `Retry-After` header is honored when present. After 5
attempts, the error propagates. High-frequency push/pull operations on busy
GitLab instances may still exhaust the budget.

### First push is slow (no commit sequence yet)

Until the first successful push writes the `_meta--commit_seq` state, every pull
performs a full state listing. After the first push, subsequent pulls use the
sequence counter for fast-path detection of changes.

### State path encoding

File paths are encoded with `--` replacing `/` separators. A file at
`data/models/foo.json` becomes GitLab state `swamp--data--models--foo.json`.
When inspecting states in the GitLab UI, use this mapping to locate files.

### `projectId` accepts both numeric IDs and URL-encoded paths

Pass either the numeric project ID (e.g., `12345`) or the URL-encoded path
(e.g., `mygroup%2Fmyproject`). URL-encoded paths with special characters must be
properly escaped.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
