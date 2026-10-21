## 2026.10.21.1

**Fixed:** The README's `swamp model create` example omitted the required
`apiKey` global argument and only said the key "should be supplied from a Swamp
vault". It now stores the key with `swamp vault put swamp-club API_KEY` and
wires it with `${{ vault.get("swamp-club", "API_KEY") }}`. The `apiKey`
argument now carries a description saying the same.

**Upgrade note:** Documentation only. No code, schema, or behavioral changes.
The model version moves to 2026.10.21.1 with an identity upgrade.
