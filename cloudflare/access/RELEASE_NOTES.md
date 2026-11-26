## 2026.11.26.1

**Fixed:** GET methods that declare query parameters ignored them: the request went out without the filters, so a call always returned the unfiltered default. Affected: `get_mcp_portals_api_portal_tool_call_timeseries`, `get_mcp_portals_api_server_tool_call_timeseries`, `get_mcp_portals_api_account_tool_call_timeseries`. They now send their query parameters, and a call that supplies any writes its own instance (suffixed with a hash of the query) instead of overwriting the shared one. Calls without query arguments keep their existing instance names.

**Added:** SCIM user and group resource methods, user population methods (`list_user_populations`, `create_user_population`, `get_user_population`, `update_user_population`, `delete_user_population`), trust settings methods, `list_users`, `delete_passkey`, MCP portal tool-call timeseries and effective redirect URI methods, custom page template validation, and Zero Trust organization update methods (22 methods).

**Upgrade note:** Regenerated from the current Cloudflare OpenAPI spec (api-schemas df5b788). Apart from the fix above, additive only.
