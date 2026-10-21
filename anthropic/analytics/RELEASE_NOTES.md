## 2026.10.21.1

**Changed:** Documentation only: the `analyticsKey` global argument description
now says to supply the key as `${{ vault.get("anthropic", "ANALYTICS_KEY") }}`
and never as a literal. The README and the registry Quick Start now create the
vault if needed and store the key with the interactive
`swamp vault put anthropic ANALYTICS_KEY` prompt before creating the model.

**Upgrade note:** No schema or behavioral changes. The model version moves to
2026.10.21.1 with an identity upgrade.
