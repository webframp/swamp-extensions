## 2026.10.14.1

**Fixed:** `get_non_compliant` and `get_summary` failed on current swamp with
`Data name 'latest' is reserved for internal use`.

**Changed:** Results are now written as `compliance-current` (spec `compliance`)
and `summary-current` (spec `summary`) instead of `latest`. Anything that read
`data.latest("<model>", "latest")` or queried `name == "latest"` must use the
new names. The README query examples now use `compliance-current`.

**Upgrade note:** Data stored under `latest` is not migrated; re-run the methods
to populate the new names. `aws/drift-state` reads this model by spec and needs
no change. No attribute schemas changed.
