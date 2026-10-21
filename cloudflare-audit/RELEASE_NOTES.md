## 2026.10.21.1

**Changed:** Documentation only: the README and the registry Quick Start now
store the Cloudflare API token in a swamp vault
(`swamp vault put cloudflare
API_TOKEN`) and wire it with
`${{ vault.get("cloudflare", "API_TOKEN") }}`. The earlier examples passed a
placeholder literal as `apiToken`, which invited pasting the raw token onto the
command line.

**Upgrade note:** No code, workflow, report, or behavioral changes.
