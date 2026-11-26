## 2026.11.26.1

**Fixed:** GET methods that declare query parameters ignored them: the request went out without the filters, so a call always returned the unfiltered default. Affected: `list_buckets`, `list_bucket_jobs`. They now send their query parameters, and a call that supplies any writes its own instance (suffixed with a hash of the query) instead of overwriting the shared one. Calls without query arguments keep their existing instance names.

**Added:** `create_bucket_by_name`, `create_bucket_job`, `get_bucket_job`, `list_bucket_jobs`, and `delete_bucket_lock_configuration`.

**Removed:** The R2 Data Catalog methods the API no longer exposes: `list_catalogs`, `enable_catalog`, `disable_catalog`, `get_catalog_details`, `list_namespaces`, `list_tables`, `get_table`, `get_maintenance_config`, `update_maintenance_config`, `get_table_maintenance_config`, `update_table_maintenance_config`, and `create_store_credentials`.

**Changed:** `create_temp_access_credentials` changed argument type: `permission`, `ttlSeconds`.

**Upgrade note:** Regenerated from the current Cloudflare OpenAPI spec (api-schemas df5b788). Callers of the methods listed under Changed must update their arguments. Other methods are unchanged.
