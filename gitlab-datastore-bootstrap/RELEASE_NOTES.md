## 2026.08.21.1

**Changed:** A malformed (non-JSON) response body from the GitLab API — e.g. an
HTML error page from a proxy in front of a self-hosted instance — now raises a
clear error naming the request method, path, and HTTP status, instead of a raw
`JSON.parse` `SyntaxError` with no indication of which request failed.

## 2026.08.02.1

**Fixed:** The `configure` job in `@webframp/bootstrap-gitlab-datastore` failed
with `Invalid expression: No such key: attributes`. The workflow queried
`data.latest("swamp-gitlab-provisioner", "state")`, but the provisioner writes
its resource under the instance name `"main"` (via
`writeResource("state", "main", ...)`) — `data.latest()`'s second argument
matches the resource's instance name, not its spec name. The `configure` job now
queries `data.latest("swamp-gitlab-provisioner", "main")`, which resolves
correctly.

**Changed:** The `run-setup` step now passes the provisioner's `datastoreConfig`
through a `DATASTORE_CONFIG` environment variable instead of interpolating it
directly into a single-quoted shell string. The prior pattern could allow a
config value containing a single quote to break out of shell quoting.

**Upgrade note:** No action needed beyond `swamp extension pull` — the workflow
file is re-pulled with the extension.
