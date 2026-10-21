## 2026.10.21.1

**Changed:** The README now shows the Snyk API token stored in a swamp vault
(`swamp vault put snyk API_TOKEN`) and wired with
`--global-arg 'apiToken=${{ vault.get("snyk", "API_TOKEN") }}'`, replacing the
literal-token example. The `apiToken` argument description says the same.

**Changed:** The `access_token`, `api_key` and `client_secret` returned by
`create_group_service_account`, `get_one_group_service_account`,
`update_group_service_account`, `update_service_account_secret`,
`create_org_service_account`, `get_one_org_service_account`,
`update_org_service_account` and `update_org_service_account_secret` are now
stored in a vault, and the persisted resource holds a `vault.get` reference in
their place. Before, they were written to swamp data in plaintext.

**Changed:** `get_many_group_service_account` and
`get_many_org_service_accounts` drop any such value from their items, because
swamp cannot vault a field inside a list; Snyk returns these secrets only on
creation or rotation.

**Changed:** Because the model now declares sensitive output, swamp refuses to
run any of its methods, reads included, until a vault exists
(`swamp vault create local_encryption snyk`).

**Changed:** The `data.attributes.secret` argument of
`update_service_account_secret` and `update_org_service_account_secret` is
marked sensitive, so swamp redacts it. Supply it with a `vault.get` expression.

**Upgrade note:** Create a vault before running any method of this extension.
Resources written by earlier versions keep any plaintext secret until you rerun
the method or delete the old data.
