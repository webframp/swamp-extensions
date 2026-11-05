## 2026.11.05.3

**Fixed:** `create_asset_search_tenant` (a POST create) writes the created
entity again. The previous version wrongly treated it as a no-content write and
returned `{ dataHandles: [] }`, dropping the created search. A POST create
persists the created entity; the `asset_search_tenant` resource is declared
again. `update_assets_bulk_tenant` and `update_tenant_membership` (genuine HTTP
204 writes) correctly remain no-write.

**Upgrade note:** The `asset_search_tenant` resource is declared again; no
stored data needs migration.

## 2026.11.05.2

**Fixed:** `update_assets_bulk_tenant`, `create_asset_search_tenant`, and
`update_tenant_membership` — write operations whose only success response is
HTTP 204 — wrote an empty resource under a dead instance name. A write whose
success response carries no body now issues the API call and returns zero data
handles, persisting nothing. The `assets_bulk_tenant`, `asset_search_tenant`,
and `tenant_membership` resources are removed.

**Changed:** The three methods above now return `{ dataHandles: [] }` and no
longer declare a resource.

**Upgrade note:** Each removed resource previously held only an empty object;
none is produced any longer. The read methods and their resources are
unchanged, so stored data continues to validate. No migration required.

## 2026.11.05.1

**Added:** Regenerated from the current Snyk OpenAPI spec. New app-install
methods `get_app_installs_for_tenant`, `create_tenant_app_install`,
`update_tenant_app_install_secret`, and `delete_tenant_app_install_by_id`, plus
lookup-by-key methods `get_asset_by_key_tenant` and `get_asset_id_by_key_tenant`.
Adds matching `tenant_app_install`, `tenant_app_install_secret`,
`get_app_installs_for_tenant`, `asset_by_key_tenant`, and
`asset_id_by_key_tenant` resources.

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
