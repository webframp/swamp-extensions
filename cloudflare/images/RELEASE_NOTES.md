## 2026.11.26.1

**Fixed:** GET methods that declare query parameters ignored them: the request went out without the filters, so a call always returned the unfiltered default. Affected: `list_images_v2`, `list_migrations`, `list_migration_logs`, `list_sources`. They now send their query parameters, and a call that supplies any writes its own instance (suffixed with a hash of the query) instead of overwriting the shared one. Calls without query arguments keep their existing instance names.

**Added:** `get`, `list_metadata_keys`, and `update_cloudflare_images_config_edit`.

**Removed:** `get_cloudflare_images_variants_variant_details_flat`, which the API no longer exposes.

**Upgrade note:** Regenerated from the current Cloudflare OpenAPI spec (api-schemas df5b788). Apart from the fixes above, additive only.
