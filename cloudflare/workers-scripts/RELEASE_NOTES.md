## 2026.08.13.1

**Fixed:** `update_cron_triggers` and `put_script_secret` now accept proper
request body arguments instead of always sending an empty payload.
`update_cron_triggers` accepts an `items` array of cron schedule objects;
`put_script_secret` accepts a `body` argument with the secret definition.

**Removed:** `put_content` and `put_script_content` methods removed — these
endpoints require multipart/form-data uploads that the JSON-only API helper
cannot support. Use wrangler for script content deployment.

**Changed:** Extension regenerated with codegen fixes for bare-array and
oneOf/discriminated-union request body handling.
