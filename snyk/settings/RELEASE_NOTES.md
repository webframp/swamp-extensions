## 2026.10.14.1

**Fixed:** Methods that write a singleton resource failed on current swamp with
`Data name 'latest' is reserved for internal use`.

**Changed:** Singleton get and action methods now write their data under
`enable_opensource_broker_for_group-current`,
`enable_opensource_broker_for_org-current`, `iac_settings_for_org-current`,
`open_source_settings_for_org-current`, `opensource_broker_setting-current`,
`org_languages_settings-current`, `sast_settings-current`,
`secrets_settings-current` instead of `latest`. Anything that read
`data.latest("<model>", "latest")` or queried `name == "latest"` must use the
new name.

**Upgrade note:** Data previously stored under `latest` is not migrated; re-run
the method to populate the new name. No attribute schemas changed.
