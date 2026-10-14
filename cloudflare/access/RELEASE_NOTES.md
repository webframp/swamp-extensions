## 2026.10.14.1

**Fixed:** Methods that write a singleton resource failed on current swamp with
`Data name 'latest' is reserved for internal use`.

**Changed:** Singleton get and action methods now write their data under
`access_applications_add_an_application-current`,
`access_applications_revoke_service_tokens-current`,
`access_gateway_ca_add_an_ssh_ca-current`,
`access_identity_providers_add_an_access_identity_provider-current`,
`access_key_configuration_rotate_access_keys-current`,
`access_saml_certificates_rotate_certificate-current`,
`access_service_tokens_refresh_a_service_token-current`,
`create_a_short_lived_certificate_ca-current`,
`create_saml_certificate_for_identity_provider-current`,
`mcp_portals_api_sync_server-current`, `the_access_key_configuration-current`,
`your_zero_trust_organization-current`,
`your_zero_trust_organization_doh_settings-current` instead of `latest`.
Anything that read `data.latest("<model>", "latest")` or queried
`name == "latest"` must use the new name.

**Upgrade note:** Data previously stored under `latest` is not migrated; re-run
the method to populate the new name. No attribute schemas changed.

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.
