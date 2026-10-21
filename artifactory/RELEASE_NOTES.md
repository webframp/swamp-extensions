## 2026.10.21.1

**Fixed:** The README, manifest and `token` argument description told you to
pass `vault://my-vault/artifactory-token`. Swamp does not resolve that syntax,
so the model received the literal string and authentication failed. They now use
`${{ vault.get("artifactory", "TOKEN") }}`, and the README stores the token with
an interactive `swamp vault put` instead of an inline value.

**Fixed:** The troubleshooting section no longer claims tokens are refreshed
automatically; it explains how to replace an expired token in the vault.

**Changed:** The 401 error message names the `swamp vault put` command to update
the token.

**Changed:** The manifest Quick Start creates the vault first with
`swamp vault create local_encryption <name>` (a once-only step for a repo with
no vault yet), so it works in a fresh repo.

**Upgrade note:** If your model's `token` global argument is a `vault://…`
string, replace it with a `vault.get` expression. No schema changes.
