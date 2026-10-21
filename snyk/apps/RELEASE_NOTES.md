## 2026.10.21.1

**Changed:** The README now shows the Snyk API token stored in a swamp vault
(`swamp vault put snyk API_TOKEN`) and wired with
`--global-arg 'apiToken=${{ vault.get("snyk", "API_TOKEN") }}'`, replacing the
literal-token example. The `apiToken` argument description says the same.

**Changed:** The `client_secret` returned by `create_group_app_install`,
`update_group_app_install_secret`, `create_org_app`,
`create_manage_app_creation_secret`, `create_org_app_install` and
`update_org_app_install_secret` is now stored in a vault, and the persisted
resource holds a `vault.get` reference in its place. Before, it was written to
swamp data in plaintext.

**Changed:** Because the model now declares sensitive output, swamp refuses to
run any of its methods, reads included, until a vault exists
(`swamp vault create local_encryption snyk`).

**Changed:** The `data.attributes.secret` argument of
`update_group_app_install_secret`, `create_manage_app_creation_secret` and
`update_org_app_install_secret` is marked sensitive, so swamp redacts it. Supply
it with a `vault.get` expression.

**Upgrade note:** Create a vault before running any method of this extension.
Resources written by earlier versions keep any plaintext `client_secret` until
you rerun the method or delete the old data.
