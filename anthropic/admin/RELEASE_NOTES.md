## 2026.10.21.1

**Fixed:** `set_member_roles` could change one more member after a cancel. When
the cancel arrived while the run was re-reading the covering group and that read
still completed, the next member was written before the run stopped. The run now
checks for cancellation right after each re-read, so the record's `changed` list
ends at the last write made before the cancel.

**Changed:** The README, the registry description, and the `adminKey` global
argument description no longer print a token-shaped key prefix. The argument
description now says to supply the key as
`${{ vault.get("anthropic", "ADMIN_KEY") }}`. The README and the registry Quick
Start now create the vault if needed and store the key with the interactive
`swamp vault put anthropic ADMIN_KEY` prompt before creating the model.

**Upgrade note:** No schema changes. The model version moves to 2026.10.21.1
with an identity upgrade.
