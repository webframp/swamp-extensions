## 2026.11.05.2

**Fixed:** `update_assets_bulk_group`, `update_assets_bulk_org`,
`create_asset_search_group`, and `create_asset_search_org` — write operations
whose only success response is HTTP 204 — wrote an empty resource under a dead
instance name. A write whose success response carries no body now issues the
API call and returns zero data handles, persisting nothing. The
`assets_bulk_group`, `assets_bulk_org`, `asset_search_group`, and
`asset_search_org` resources are removed.

**Changed:** The four methods above now return `{ dataHandles: [] }` and no
longer declare a resource.

**Upgrade note:** Each removed resource previously held only an empty object;
none is produced any longer. The read methods and their resources are
unchanged, so stored data continues to validate. No migration required.

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
