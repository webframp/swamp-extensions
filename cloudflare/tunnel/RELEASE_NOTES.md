## 2026.10.21.1

**Changed:** The README and the `apiToken` description now lead with a vault.
Store the token with `swamp vault put cloudflare API_TOKEN` and set `apiToken`
to `${{ vault.get("cloudflare", "API_TOKEN") }}`. The `CLOUDFLARE_API_TOKEN`
environment variable still works as a fallback, but swamp does not redact it, so
it is no longer recommended. The missing-token error now says the same.

**Changed:** Method arguments that carry a secret are now marked sensitive, so
swamp redacts them from logs and run records. Pass them as `vault.get`
expressions. Affected: `create_a_cloudflare_tunnel` and
`update_a_cloudflare_tunnel`. The README's new "Secrets" section lists them per
method.

**Changed:** Secrets returned by `get_a_cloudflare_tunnel_management_token` and
`get_a_cloudflare_tunnel_token` are now stored in a vault, and the stored
resource holds a `vault.get` reference instead of the value. Because the model
now declares secret output, swamp refuses to run any of the model's methods,
reads included, until a vault exists
(`swamp vault create local_encryption cloudflare`). The README's "Secrets"
section lists what each method stores.

**Fixed:** `get_a_cloudflare_tunnel_management_token` wrote to a resource the
model does not declare, so it always failed. It now writes the resource the
model declares.

**Upgrade note:** Tunnel `get_a_cloudflare_tunnel_token` and
`get_a_cloudflare_tunnel_management_token` now store `{ value }`, a vault
reference, instead of the bare token string. Resources stored by earlier
versions of the methods in the README's "Secrets" section may hold plaintext
secrets; delete them with `swamp data delete` and rotate the affected
credentials.
