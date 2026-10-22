## 2026.10.22.1

**Fixed:** Existing definitions created against an earlier version were stranded on upgrade. The model shipped new versions without a corresponding `upgrades` chain, so swamp could not migrate a definition's `typeVersion` and logged a warning that global arguments would not be migrated. This release backfills the full upgrade chain through every shipped version and terminates it at the current version, so stale definitions migrate cleanly. The transform is identity — no stored global argument value changes.

**Changed:** The chain records that the `token` global argument became sensitive at 2026.10.21.1. This is a schema attribute, not a stored-value change, so the identity transform carries the existing token reference forward unchanged.

**Upgrade note:** No action required. On the next method run, each existing definition's `typeVersion` advances to 2026.10.22.1 with its global arguments preserved.

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
