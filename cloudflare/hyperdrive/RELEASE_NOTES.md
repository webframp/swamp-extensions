## 2026.11.26.1

**Added:** `create_hyperdrive_database_signature` and `restart_hyperdrive`.

**Changed:** `create_hyperdrive` no longer takes `caching`, `created_on`, `modified_on`, `mtls`, `name`, `origin`, `origin_connection_limit`. `update_hyperdrive` changed argument type: `origin`. `patch_hyperdrive` changed argument type: `name`.

**Upgrade note:** Regenerated from the current Cloudflare OpenAPI spec (api-schemas df5b788). Callers of the methods listed under Changed must update their arguments. Other methods are unchanged.
