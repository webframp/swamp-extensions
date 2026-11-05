## 2026.11.05.1

**Fixed:** `disable_catalog` is a write whose success response carries no
body (HTTP 204). Earlier versions declared a `disable_catalog` resource with an
empty schema and wrote an empty `{}` to it under a constant instance name on
every call. The method now issues the API call for its side effect and returns
no data handles — it stores nothing. The empty `disable_catalog` resource spec
is gone.

**Upgrade note:** The `disable_catalog` resource is no longer declared. Any data
earlier versions wrote under it is stale; delete it with `swamp data delete`.

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README and the `apiToken` description now lead with a vault.
Store the token with `swamp vault put cloudflare API_TOKEN` and set `apiToken`
to `${{ vault.get("cloudflare", "API_TOKEN") }}`. The `CLOUDFLARE_API_TOKEN`
environment variable still works as a fallback, but swamp does not redact it, so
it is no longer recommended. The missing-token error now says the same.

**Changed:** Method arguments that carry a secret are now marked sensitive, so
swamp redacts them from logs and run records. Pass them as `vault.get`
expressions. Affected: `create_store_credentials` and `put_bucket_sippy_config`.
The README's new "Secrets" section lists them per method.

**Changed:** Secrets returned by `create_temp_access_credentials` are now stored
in a vault, and the stored resource holds a `vault.get` reference instead of the
value. Because the model now declares secret output, swamp refuses to run any of
the model's methods, reads included, until a vault exists
(`swamp vault create local_encryption cloudflare`). The README's "Secrets"
section lists what each method stores.

**Fixed:** `update_maintenance_config` and `update_table_maintenance_config`
wrote to a resource the model does not declare, so they always failed. They now
write the resource the model declares.

**Fixed:** Create methods whose response carries no `id` wrote every result to
one instance named `created`, so each call overwrote the previous one. They now
name the instance by the response's `id` when present, else by the path
parameter that scopes the call, else by a hash of the request arguments (secret
arguments left out). Affected: `create_store_credentials`, `create_bucket`,
`create_r2_add_custom_domain` and `create_temp_access_credentials`.

**Upgrade note:** Resources stored by earlier versions of the methods in the
README's "Secrets" section may hold plaintext secrets; delete them with
`swamp data delete` and rotate the affected credentials. Results earlier
versions wrote to the `created` instance stay there; new runs write under the
new names.
