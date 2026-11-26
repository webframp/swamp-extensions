## 2026.11.26.1

**Added:** `list_email_routing_settings_email_routing_dns_settings` and `get_sending_subdomain_reputation_complaints`.

**Removed:** The suppression methods (`*_publicnewsuppressionzone*`, `*_publicdeletesuppressionzone*`, `*_publicgetsuppressionzone*`, `*_publiclistsuppressionzone*` for routing and sending) and `get_email_routing_settings_email_routing_dns_settings`, which the API no longer exposes. The DNS settings read is replaced by the new list method.

**Upgrade note:** Regenerated from the current Cloudflare OpenAPI spec (api-schemas df5b788). Callers of the removed methods must stop using them.
