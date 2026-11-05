## 2026.11.05.1

**Added:** Regenerated from the current fal.ai OpenAPI spec. New
`serverless_stop_runner` method (POST `/serverless/runners/{id}/stop`) to
request a graceful stop of a serverless runner, with an optional `replace_first`
argument to start a replacement before stopping, plus a matching
`serverless_stop_runner` resource.

**Upgrade note:** Additive only — existing methods, arguments, and resource
schemas are unchanged, so stored data continues to validate. No migration
required.

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README, the `apiToken` description and the missing-key error
now direct you to store the fal.ai API key in a vault
(`swamp vault put falai API_KEY`) and wire it with
`--global-arg 'apiToken=${{ vault.get("falai", "API_KEY") }}'`. The README
previously showed `--global-arg apiToken=FAL_API_KEY`, which invited passing the
key as a literal. The `FAL_KEY` environment variable is still read as a
fallback, but it is not redacted and is not recommended.

No method behavior changed. Stored resources need no migration.
