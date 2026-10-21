## 2026.10.21.1

**Changed:** Documentation only: the README, the registry description, and the
`complianceKey` global argument description no longer print a token-shaped key
prefix. The argument description now says to supply the key as
`${{ vault.get("anthropic", "COMPLIANCE_KEY") }}`. The README and the registry
Quick Start now create the vault if needed and store the key with the
interactive `swamp vault put anthropic COMPLIANCE_KEY` prompt before creating
the model.

**Upgrade note:** No code, schema, or behavioral changes. The model version
moves to 2026.10.21.1 with an identity upgrade.
