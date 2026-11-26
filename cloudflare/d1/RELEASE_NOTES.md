## 2026.11.26.1

**Fixed:** GET methods that declare query parameters ignored them: the request went out without the filters, so a call always returned the unfiltered default. Affected: `get_database`, `get_bookmark`, `list_insights_recommendations`. They now send their query parameters, and a call that supplies any writes its own instance (suffixed with a hash of the query) instead of overwriting the shared one. Calls without query arguments keep their existing instance names.

**Added:** Insights methods: `get_insights_settings`, `update_insights_settings`, `list_insights_databases`, `list_insights_queries`, `list_insights_recommendations`.

**Upgrade note:** Regenerated from the current Cloudflare OpenAPI spec (api-schemas df5b788). Additive only; existing methods are unchanged.
