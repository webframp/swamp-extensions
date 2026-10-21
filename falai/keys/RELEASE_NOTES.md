## 2026.10.21.1

**Changed:** `create_api_key` now keeps the new key. The one-time `key_secret`
and the combined `key` were previously dropped before the `api_key` resource was
written, so the secret fal.ai returns only once was lost. Both fields are now
marked sensitive in the resource schema: swamp stores each value in a vault and
the resource holds a `vault.get(...)` reference in its place.

**Changed:** The README, the `apiToken` description and the missing-key error
now direct you to store the fal.ai API key in a vault
(`swamp vault put falai API_KEY`) and wire it with
`--global-arg 'apiToken=${{ vault.get("falai", "API_KEY") }}'`. The `FAL_KEY`
environment variable is still read as a fallback, but it is not redacted and is
not recommended.

**Upgrade note:** Because the model now declares sensitive output, swamp refuses
to run any of its methods (`list_api_keys`, `create_api_key` and
`revoke_api_key`) until a vault exists; create one with
`swamp vault create local_encryption falai`. `create_api_key` is refused before
any key is created. Stored resources need no migration.
