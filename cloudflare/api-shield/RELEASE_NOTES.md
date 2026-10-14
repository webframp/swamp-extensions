## 2026.10.14.1

**Fixed:** Methods that write a singleton resource failed on current swamp with
`Data name 'latest' is reserved for internal use`.

**Changed:** Singleton get and action methods now write their data under
`api_shield_api_discovery_retrieve_discovered_operations_on_a_zone_as_openapi-current`,
`api_shield_endpoint_management_add_operations_to_a_zone-current`,
`api_shield_endpoint_management_retrieve_operations_and_features_as_open_api_schemas-current`,
`api_shield_settings_retrieve_information_about_specific_configuration_properties-current`,
`create_user_labels-current` instead of `latest`. Anything that read
`data.latest("<model>", "latest")` or queried `name == "latest"` must use the
new name.

**Upgrade note:** Data previously stored under `latest` is not migrated; re-run
the method to populate the new name. No attribute schemas changed.
