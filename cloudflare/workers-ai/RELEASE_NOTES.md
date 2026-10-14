## 2026.10.14.1

**Fixed:** Methods that write a singleton resource failed on current swamp with
`Data name 'latest' is reserved for internal use`.

**Changed:** 95 singleton get and action methods now write their data under
`<spec>-current` (for example `credit_balance-current`,
`invoice_history-current`) instead of `latest`; the spec name is the method name
without its `get_`/`action_` prefix. Anything that read
`data.latest("<model>", "latest")` or queried `name == "latest"` must use the
new name.

**Upgrade note:** Data previously stored under `latest` is not migrated; re-run
the method to populate the new name. No attribute schemas changed.
