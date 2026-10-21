## 2026.10.21.1

**Changed:** The `apiKey` global argument is marked sensitive. Swamp redacts it
and rejects a literal key; supply it with
`${{ vault.get("discourse", "API_KEY") }}`.

**Changed:** The manifest and README show how to store the key with
`swamp vault put` and wire it with `vault.get`.

**Changed:** The manifest Quick Start creates the vault first with
`swamp vault create local_encryption <name>` (a once-only step for a repo with
no vault yet), so it works in a fresh repo.

**Upgrade note:** A model whose `apiKey` is a literal string now fails
validation. Store the key in a vault and replace the value with a `vault.get`
expression. Public forums without `apiKey` are unaffected.
