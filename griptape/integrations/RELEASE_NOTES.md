## 2026.11.26.1

**Changed:** Breaking removal. Griptape Cloud dropped `/api/connections` from its
API, so `list_connections`, `create_connection`, `delete_connection`, and
`get_token` are removed. The manifest description and labels no longer mention
connections. Regenerated from the current Griptape OpenAPI spec.

**Upgrade note:** Workflows or models that call the removed methods must stop
using them. Stored `connections` data remains readable but is no longer
written. The remaining integration methods are unchanged.
