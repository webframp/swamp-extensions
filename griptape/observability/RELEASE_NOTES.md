## 2026.11.26.1

**Changed:** A response schema no longer declares the `tool_id` field, which the
current Griptape OpenAPI spec dropped. Regenerated from that spec.

**Upgrade note:** Methods and arguments are unchanged. Previously stored data
that carries `tool_id` still validates because response schemas are loose.
