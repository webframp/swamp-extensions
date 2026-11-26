## 2026.11.26.1

**Added:** `create_bucket_by_name`, `create_bucket_job`, `get_bucket_job`, `list_bucket_jobs`, and `delete_bucket_lock_configuration`.

**Removed:** The R2 Data Catalog methods the API no longer exposes: `list_catalogs`, `enable_catalog`, `disable_catalog`, `get_catalog_details`, `list_namespaces`, `list_tables`, `get_table`, `get_maintenance_config`, `update_maintenance_config`, `get_table_maintenance_config`, `update_table_maintenance_config`, and `create_store_credentials`.

**Upgrade note:** Regenerated from the current Cloudflare OpenAPI spec (api-schemas df5b788). Callers of the removed methods must stop using them.
