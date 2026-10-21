## 2026.10.21.1

**Changed:** Documentation only: the README and the registry Quick Start now
store the Redmine API key in a swamp vault (`swamp vault put redmine API_KEY`)
and wire the `tracker` instance with `${{ vault.get("redmine", "API_KEY") }}`.
The earlier examples passed `apiKey=YOUR_API_KEY`, which invited pasting the raw
key onto the command line.

**Upgrade note:** No code, workflow, report, or behavioral changes.
