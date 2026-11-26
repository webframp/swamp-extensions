## 2026.11.26.1

**Removed:** 13 methods the API no longer exposes: `catalog_syncs_refresh`, `create_resources_catalog_policy_preview`, `get_catalog_syncs_read`, `get_onramps_mwan_addr_space_read`, `get_onramps_read`, `get_providers_initial_setup`, `get_providers_read`, `get_resources_catalog_read`, `onramps_apply`, `onramps_plan`, `patch`, `providers_discover`, `providers_discover_all`.

**Changed:** `create` now calls `POST /magic/connectors`; requires `device`; no longer takes `description`, `destination_type`, `name`, `policy`, `update_mode`. `update` now calls `PUT /magic/connectors/{connector_id}`; requires `connector_id`; no longer takes `sync_id`, `description`, `name`, `policy`, `update_mode`. `delete` now calls `DELETE /magic/connectors/{connector_id}`; requires `connector_id`; no longer takes `sync_id`, `delete_destination`. `update_mconn_connectors_edit` no longer takes `primary`, `site_id`.

**Upgrade note:** Regenerated from the current Cloudflare OpenAPI spec (api-schemas df5b788). Callers of the methods listed under Changed must update their arguments. Other methods are unchanged.
