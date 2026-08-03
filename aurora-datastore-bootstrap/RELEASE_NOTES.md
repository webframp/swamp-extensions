## 2026.08.02.1

**Fixed:** The `configure` job in `@webframp/bootstrap-aurora-datastore` failed
with `Invalid expression: No such key: attributes`. The workflow queried
`data.latest("swamp-aurora-provisioner", "state")`, but the provisioner writes
its resource under the instance name `"main"` (via
`writeResource("state", "main", ...)`) — `data.latest()`'s second argument
matches the resource's instance name, not its spec name. The `configure` job now
queries `data.latest("swamp-aurora-provisioner", "main")`, which resolves
correctly.

**Added:** The provisioner now writes a `datastoreConfig` field (JSON string of
`{connectionString, ssl}`), matching the pattern used by the other datastore
bootstrap extensions. The existing `connectionString` field is unchanged.

**Changed:** The `run-setup` step now passes the provisioner's `datastoreConfig`
through a `DATASTORE_CONFIG` environment variable instead of building the config
JSON inline inside a single-quoted shell string. The prior pattern embedded the
connection string (which includes the URL-encoded master password) directly into
both a JSON literal and a shell single-quoted argument, so a password containing
a single quote or double quote could corrupt the command or the JSON payload.

**Upgrade note:** No action needed beyond `swamp extension pull` — the
provisioner and workflow files are re-pulled with the extension.
