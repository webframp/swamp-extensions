## 2026.10.14.1

**Fixed:** Methods that write a singleton resource failed on current swamp with
`Data name 'latest' is reserved for internal use`.

**Changed:** Singleton get and action methods now write their data under
`bulkcreateprefixes-current`, `catalog_syncs_refresh-current`,
`create_cf1_site_ramps-current`, `create_cf1_sites-current`,
`getprotectionstatus-current`, `list_gre_tunnels-current`,
`list_interconnects-current`, `list_ipsec_tunnels-current`,
`list_redundancy_groups-current`, `list_routes-current`,
`magic_ipsec_tunnels_generate_pre_shared_key_psk_for_ipsec_tunnels-current`,
`onramps_apply-current`, `onramps_mwan_addr_space_read-current`,
`onramps_plan-current`, `providers_discover-current`,
`providers_discover_all-current`, `settings-current` instead of `latest`.
Anything that read `data.latest("<model>", "latest")` or queried
`name == "latest"` must use the new name.

**Upgrade note:** Data previously stored under `latest` is not migrated; re-run
the method to populate the new name. No attribute schemas changed.

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.
