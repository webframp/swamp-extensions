## 2026.10.21.1

**Changed:** The README's configuration example no longer shows a literal
`token:` in the vault config. A new Authentication section leads with
`vault login`, which stores the token in `~/.vault-token` where the provider
reads it, and warns against putting a literal token in the config or relying on
`VAULT_TOKEN`. The `token` config field description and the "No Vault token
found" error message now say the same; the error text changed, so update
anything that matches on its old wording.

**Fixed:** Tracing spans reported a stale instrumentation version
(`2026.08.20.1`) instead of the published version. The tracer version now
matches `manifest.yaml`, and a test fails if the two drift apart again (the
`test` task in `deno.json` now grants read access to `manifest.yaml` for it).

**Fixed:** The model-definition example used `{{ vault('hashi', ...) }}`, which
is not swamp syntax and never resolved to the secret: swamp rejects a literal
value for an argument marked sensitive, and passes it through as literal text to
one that is not. It now uses `${{ vault.get("hashi", "...") }}`. The
`swamp vault read-secret
--force` example now warns that it prints the plaintext
value.

**Upgrade note:** The token resolution order is unchanged (config `token`, then
`VAULT_TOKEN`, then `~/.vault-token`), so existing setups keep working.
