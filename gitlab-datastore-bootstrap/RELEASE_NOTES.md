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
