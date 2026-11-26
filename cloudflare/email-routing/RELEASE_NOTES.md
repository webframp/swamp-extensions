## 2026.11.26.1

**Fixed:** GET methods that declare query parameters ignored them: the request went out without the filters, so a call always returned the unfiltered default. Affected: `get_sending_subdomain_reputation_complaints`. They now send their query parameters, and a call that supplies any writes its own instance (suffixed with a hash of the query) instead of overwriting the shared one. Calls without query arguments keep their existing instance names.

**Added:** `list_email_routing_settings_email_routing_dns_settings` and `get_sending_subdomain_reputation_complaints`.

**Removed:** The suppression methods (`*_publicnewsuppressionzone*`, `*_publicdeletesuppressionzone*`, `*_publicgetsuppressionzone*`, `*_publiclistsuppressionzone*` for routing and sending) and `get_email_routing_settings_email_routing_dns_settings`, which the API no longer exposes. The DNS settings read is replaced by the new list method.

**Changed:** `update_sending_subdomain` changed argument type: `preview_enabled`.

**Upgrade note:** Regenerated from the current Cloudflare OpenAPI spec (api-schemas df5b788). Callers of the methods listed under Changed must update their arguments. Other methods are unchanged.
