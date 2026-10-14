## 2026.10.14.1

**Fixed:** Methods that write a singleton resource failed on current swamp with
`Data name 'latest' is reserved for internal use`.

**Changed:** Singleton get and action methods now write their data under
`audit_ssh_settings-current`, `create_zero_trust_account-current`,
`list-current`, `logging_settings_for_the_zero_trust_account-current`,
`zero_trust_account_configuration-current`,
`zero_trust_account_information-current`,
`zero_trust_certificates_activate_zero_trust_certificate-current`,
`zero_trust_certificates_deactivate_zero_trust_certificate-current`,
`zero_trust_gateway_rules_reset_expiration_zero_trust_gateway_rule-current`,
`zero_trust_rotate_ssh_account_seed-current` instead of `latest`. Anything that
read `data.latest("<model>", "latest")` or queried `name == "latest"` must use
the new name.

**Upgrade note:** Data previously stored under `latest` is not migrated; re-run
the method to populate the new name. No attribute schemas changed.

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.
