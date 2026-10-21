## 2026.10.21.1

**Changed:** Documentation only: the README and the registry Quick Start now
store the Redmine API key in a swamp vault (`swamp vault put redmine API_KEY`)
and wire it with `${{ vault.get("redmine", "API_KEY") }}`. The earlier examples
passed `apiKey=YOUR_API_KEY`, which invited pasting the raw key onto the command
line. The `apiKey` global argument description says the same.

**Upgrade note:** No code, schema, or behavioral changes. The model version
moves to 2026.10.21.1 with an identity upgrade, so existing instances need no
changes.
