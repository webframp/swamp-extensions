## 2026.10.14.1

**Fixed:** Methods that write a singleton resource failed on current swamp with
`Data name 'latest' is reserved for internal use`.

**Changed:** Singleton get and action methods now write their data under
`pages_deployment_retry_deployment-current`,
`pages_deployment_rollback_deployment-current`,
`pages_purge_build_cache-current` instead of `latest`. Anything that read
`data.latest("<model>", "latest")` or queried `name == "latest"` must use the
new name.

**Upgrade note:** Data previously stored under `latest` is not migrated; re-run
the method to populate the new name. No attribute schemas changed.
