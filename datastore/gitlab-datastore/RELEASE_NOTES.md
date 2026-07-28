## 2026.07.27.1

**Changed:** Bump @opentelemetry/api 1.9.0 → 1.9.1

## 2026.07.25.1

**Added:** OpenTelemetry spans for every layer of the datastore. All GitLab API
calls now flow through a single choke point that emits one span each
(`GitLab getState`, `GitLab putState`, `GitLab lock`, `GitLab listStates`, …)
carrying the HTTP method, response status, project ID, state name, and server
host. The lock emits `gitlab-datastore lock acquire` / `release` / `withLock` /
`inspect` / `forceRelease`, with acquire recording wait duration, contention,
and the current holder. The sync service emits
`gitlab-datastore pullChanged` / `pushChanged` / `hydrateFile` / `preparePush` /
`commitPush` with file counts and the number of states listed.

**Added:** Lock retries are recorded as `retry` span events, distinguishing
ordinary contention from stealing a stale lock.

**Changed:** Non-2xx responses now mark their span as an error, except where a
status is normal control flow — a 404 from `getState` meaning the state does
not exist, a 409 or 423 from `lock` meaning another holder has it, a 404 or 204
from `getLockInfo` meaning the state is unlocked. This client inspects
`response.status` by hand rather than throwing, so without the distinction a
span would have reported success on a 500.

**Changed:** `pushChanged` records `datastore.dirty_path_mode` rather than
`datastore.fast_path_hit`. In the sibling extensions `fast_path_hit` means no
work was done; this method has no short-circuit, and a dirty-path push that
uploads files is not a fast path.

**Changed:** Nothing observable without tracing configured. The extension
depends on `@opentelemetry/api` only; the host process owns the
TracerProvider, and every span is a no-op when none is registered. Existing
behaviour, return values, and log output are unchanged.

**Note on secrets:** Every request carries a PRIVATE-TOKEN header and request
bodies carry file content. Neither headers nor bodies are ever recorded — span
attributes hold only the operation name, HTTP method, status, project ID, state
name, and host. A test asserts no span attribute contains the token.
