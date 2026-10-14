## 2026.10.14.1

**Fixed:** Methods that write a singleton resource failed on current swamp with
`Data name 'latest' is reserved for internal use`.

**Changed:** Singleton get and action methods now write their data under
`catch_all_rule-current`, `dmarc_reports_status-current`,
`email_routing_settings-current`,
`email_routing_settings_email_routing_dns_settings-current`,
`email_sending_subdomains_fix_sending_subdomain_dns-current`,
`inspect_spf-current` instead of `latest`. Anything that read
`data.latest("<model>", "latest")` or queried `name == "latest"` must use the
new name.

**Upgrade note:** Data previously stored under `latest` is not migrated; re-run
the method to populate the new name. No attribute schemas changed.
