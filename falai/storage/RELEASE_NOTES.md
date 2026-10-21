## 2026.10.21.1

**Changed:** The README, the `apiToken` description and the missing-key error
now direct you to store the fal.ai API key in a vault
(`swamp vault put falai API_KEY`) and wire it with
`--global-arg 'apiToken=${{ vault.get("falai", "API_KEY") }}'`. The README
previously showed `--global-arg apiToken=FAL_API_KEY`, which invited passing the
key as a literal. The `FAL_KEY` environment variable is still read as a
fallback, but it is not redacted and is not recommended.

No method behavior changed. Stored resources need no migration.
