## 2026.08.02.1

**Fixed:** The `configure` job in `@webframp/bootstrap-aurora-datastore` failed
with `Invalid expression: No such key: attributes`. The workflow queried
`data.latest("swamp-aurora-provisioner", "state")`, but the provisioner writes
its resource under the instance name `"main"` (via
`writeResource("state", "main", ...)`) — `data.latest()`'s second argument
matches the resource's instance name, not its spec name. The `configure` job now
queries `data.latest("swamp-aurora-provisioner", "main")`, which resolves
correctly.

**Added:** The provisioner now writes an optional `datastoreConfig` field (JSON
string of `{connectionString, ssl}`), matching the pattern used by the other
datastore bootstrap extensions. The existing `connectionString` field is
unchanged. The field is optional so resources written by prior versions remain
readable.

**Changed:** The `run-setup` step now passes the provisioner's `datastoreConfig`
through a `DATASTORE_CONFIG` environment variable instead of building the config
JSON inline inside a single-quoted shell string. The prior pattern embedded the
connection string (which includes the URL-encoded master password) directly into
both a JSON literal and a shell single-quoted argument, so a password containing
a single quote or double quote could corrupt the command or the JSON payload.

**Upgrade note:** If you provisioned with a prior version, your stored resource
predates the `datastoreConfig` field. Re-run the `infra` job (or the whole
workflow) once after upgrading so `provision` rewrites the resource with
`datastoreConfig` populated — otherwise the `configure` job's `run-setup` step
will receive an empty `DATASTORE_CONFIG`.
