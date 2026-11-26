## 2026.11.26.1

**Fixed:** `add_team_hierarchy_link` sent `{"data": {"attributes": {...}}}`
without the `team_hierarchy_links` type, so the request body did not match the
API. It now sends `{"data": {"type": "team_hierarchy_links", ...}}` with its
arguments beside the type, and no longer asks for a `type` argument.

**Upgrade note:** Callers that passed `type` to `add_team_hierarchy_link` should
drop it. Other methods, resource schemas and stored data are unchanged.
