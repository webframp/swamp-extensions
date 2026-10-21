## 2026.10.21.1

**Fixed:** `setup` failed to store the generated token with current swamp
releases, because it passed an unsupported `--stdin` flag to `swamp vault put`.
The token is still piped on stdin, never on argv.

**Fixed:** `setup` error messages could echo the raw
`ssh exe.dev ssh-key
generate-api-key` output, which may contain the token. They
now withhold the output, use stderr only on an ssh failure, and mask anything
token-shaped.

**Changed:** The `token` global argument is marked sensitive, so swamp rejects a
literal token and redacts the value. Supply it with
`${{ vault.get("exe-dev", "API_TOKEN") }}` (or your own vault and key).

**Changed:** README and manifest show the vault flow: create a vault, run
`setup` with `--input vaultName=… --input secretKey=…`, then wire `token` with
`vault.get`. The manual alternative pipes only the first generated token
straight into `swamp vault put --yes`, so re-running it rotates the stored
value. The `setup` defaults are unchanged (vault `gitlab`, key
`exe-dev-api-token`); its argument descriptions, the missing-token error and the
README now state them and recommend passing both inputs explicitly. The `env`
argument of `create` now says to pass secret values as `vault.get` expressions.

**Upgrade note:** A model whose `token` is a literal string now fails
validation. Store the token with `setup` (or `swamp vault put`) and replace it
with a `vault.get` expression.
