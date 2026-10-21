## 2026.10.21.1

**Changed:** The README and the `apiToken` description now lead with a vault.
Store the token with `swamp vault put cloudflare API_TOKEN` and set `apiToken`
to `${{ vault.get("cloudflare", "API_TOKEN") }}`. The `CLOUDFLARE_API_TOKEN`
environment variable still works as a fallback, but swamp does not redact it, so
it is no longer recommended. The missing-token error now says the same.

**Changed:** Method arguments that carry a secret are now marked sensitive, so
swamp redacts them from logs and run records. Pass them as `vault.get`
expressions. Affected: `create_ipsec_tunnels`,
`create_magic_ipsec_tunnels_set_pre_shared_keys_for_ipsec_tunnels` and
`update_ipsec_tunnel`. The README's new "Secrets" section lists them per method.

**Changed:** Secrets returned by
`magic_ipsec_tunnels_generate_pre_shared_key_psk_for_ipsec_tunnels` are now
stored in a vault, and the stored resource holds a `vault.get` reference instead
of the value. Because the model now declares secret output, swamp refuses to run
any of the model's methods except `list` and `get` (which swamp treats as reads
by their names) until a vault exists
(`swamp vault create local_encryption cloudflare`). The README's "Secrets"
section lists what each method stores.

**Changed:** Secrets inside list items, maps or unions, which swamp cannot move
into a vault, are now removed before the result is stored. Affected:
`create_magic_ipsec_tunnels_set_pre_shared_keys_for_ipsec_tunnels`.

**Fixed:** `create_cf1_sites` and `create_cf1_site_ramps` wrote to a resource
the model does not declare, so they always failed. They now write the resource
the model declares.

**Fixed:** Create methods whose response carries no `id` wrote every result to
one instance named `created`, so each call overwrote the previous one. They now
name the instance by the response's `id` when present, else by the path
parameter that scopes the call, else by a hash of the request arguments (secret
arguments left out). Affected: `create_magic_account_apps_add_app`,
`create_resources_catalog_policy_preview`,
`create_magic_ipsec_tunnels_set_pre_shared_keys_for_ipsec_tunnels` and
`create_netflow_config`.

**Upgrade note:** Resources stored by earlier versions of the methods in the
README's "Secrets" section may hold plaintext secrets; delete them with
`swamp data delete` and rotate the affected credentials. Results earlier
versions wrote to the `created` instance stay there; new runs write under the
new names.
