## 2026.10.21.1

**Changed:** The README and the `apiToken` description now lead with a vault.
Store the token with `swamp vault put cloudflare API_TOKEN` and set `apiToken`
to `${{ vault.get("cloudflare", "API_TOKEN") }}`. The `CLOUDFLARE_API_TOKEN`
environment variable still works as a fallback, but swamp does not redact it, so
it is no longer recommended. The missing-token error now says the same.

**Changed:** Method arguments that carry a secret are now marked sensitive, so
swamp redacts them from logs and run records. Pass them as `vault.get`
expressions. Affected: `create_project` and `update_project`. The README's new
"Secrets" section lists them per method.

**Changed:** Secrets returned by `get_upload_token` are now stored in a vault,
and the stored resource holds a `vault.get` reference instead of the value.
Because the model now declares secret output, swamp refuses to run any of the
model's methods, reads included, until a vault exists
(`swamp vault create local_encryption cloudflare`). The README's "Secrets"
section lists what each method stores.

**Changed:** Secrets inside list items, maps or unions, which swamp cannot move
into a vault, are now removed before the result is stored. Affected:
`get_projects`, `create_project`, `get_project`, `update_project`,
`get_deployments`, `get_deployment_info` and 3 more.

**Upgrade note:** Resources stored by earlier versions of the methods in the
README's "Secrets" section may hold plaintext secrets; delete them with
`swamp data delete` and rotate the affected credentials.
