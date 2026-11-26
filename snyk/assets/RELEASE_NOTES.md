## 2026.11.26.1

**Changed:** The `version` global argument now defaults to the Snyk REST API version `2026-09-09` (was `2024-10-15`). Models that set `version` explicitly keep their value.

**Added:** `update_asset`, `list_repository_aliases_in_group`, `create_alias_in_group`, and `delete_aliases_in_group`; an optional `labels` list and `display_name` on asset classes.

**Fixed:** `delete_aliases_in_group` required a `data` argument but never sent it. It now sends the argument as the request body.

**Changed:** Asset `tags` are key:value pairs in API `2026-09-09` (a list of strings before). The `tags` schema accepts both shapes, so assets stored under the earlier version still validate; the former string tags are now `labels` in the API. `class.name` is no longer declared on asset classes (the API now returns `display_name`); stored values are kept.

**Upgrade note:** The default API version change takes effect for models that rely on it. Pin `version` to `2024-10-15` to keep the old API behavior. Stored assets remain readable; their `tags` keep the earlier list shape until fetched again.
