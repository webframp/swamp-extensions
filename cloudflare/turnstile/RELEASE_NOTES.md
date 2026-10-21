## 2026.10.21.1

**Changed:** The README and the `apiToken` description now lead with a vault.
Store the token with `swamp vault put cloudflare API_TOKEN` and set `apiToken`
to `${{ vault.get("cloudflare", "API_TOKEN") }}`. The `CLOUDFLARE_API_TOKEN`
environment variable still works as a fallback, but swamp does not redact it, so
it is no longer recommended. The missing-token error now says the same.

**Changed:** Secrets returned by `get_create`, `get_get`, `get_update` and
`get_rotate_secret` are now stored in a vault, and the stored resource holds a
`vault.get` reference instead of the value. Because the model now declares
secret output, swamp refuses to run any of the model's methods except `list`
(which swamp treats as a read by its name) until a vault exists
(`swamp vault create local_encryption cloudflare`). The README's "Secrets"
section lists what each method stores.

**Fixed:** `get_create`, `get_update` and `get_rotate_secret` wrote to a
resource the model does not declare, so they always failed. They now write the
resource the model declares.

**Upgrade note:** Resources stored by earlier versions of the methods in the
README's "Secrets" section may hold plaintext secrets; delete them with
`swamp data delete` and rotate the affected credentials.
