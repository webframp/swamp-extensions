## 2026.11.05.1

**Changed:** Regenerated from the current Snyk OpenAPI spec. The asset schema
gains an optional `id_from_source` field (the asset's identifier in the source
SCM system it was discovered from). No methods were added or removed.

**Upgrade note:** Additive only — the new field is optional, so existing stored
data continues to validate. No migration required.

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README now shows the Snyk API token stored in a swamp vault
(`swamp vault put snyk API_TOKEN`) and wired with
`--global-arg 'apiToken=${{ vault.get("snyk", "API_TOKEN") }}'`, replacing the
literal-token example. The `apiToken` argument description says the same.

Documentation only: nothing behavioral changed. This API returns no secrets.
