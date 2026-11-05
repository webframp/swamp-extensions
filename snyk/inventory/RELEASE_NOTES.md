## 2026.11.05.1

**Added:** Regenerated from the current Snyk OpenAPI spec. New lookup-by-key
methods `get_asset_by_key_org`, `get_asset_id_by_key_org`,
`get_asset_by_key_group`, and `get_asset_id_by_key_group`, with matching
`asset_by_key_org`, `asset_id_by_key_org`, `asset_by_key_group`, and
`asset_id_by_key_group` resources.

**Upgrade note:** Additive only — existing methods, arguments, and resource
schemas are unchanged, so stored data continues to validate. No migration
required.

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README now shows the Snyk API token stored in a swamp vault
(`swamp vault put snyk API_TOKEN`) and wired with
`--global-arg 'apiToken=${{ vault.get("snyk", "API_TOKEN") }}'`, replacing the
literal-token example. The `apiToken` argument description says the same.

Documentation only: nothing behavioral changed. This API returns no secrets.
