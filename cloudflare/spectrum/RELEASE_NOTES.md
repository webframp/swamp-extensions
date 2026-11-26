## 2026.11.26.1

**Fixed:** GET methods that declare query parameters ignored them: the request went out without the filters, so a call always returned the unfiltered default. Affected: `get_analytics_by_time`, `get_analytics_summary`, `list_spectrum_applications`. They now send their query parameters, and a call that supplies any writes its own instance (suffixed with a hash of the query) instead of overwriting the shared one. Calls without query arguments keep their existing instance names.

**Added:** `list_spectrum_application_protocols`.

**Changed:** `create_spectrum_application_using_a_name_for_the_origin` changed argument type: `body`. `update_spectrum_application_configuration_using_a_name_for_the_origin` changed argument type: `body`.

**Upgrade note:** Regenerated from the current Cloudflare OpenAPI spec (api-schemas df5b788). Callers of the methods listed under Changed must update their arguments. Other methods are unchanged.
