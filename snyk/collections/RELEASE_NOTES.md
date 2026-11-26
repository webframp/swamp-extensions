## 2026.11.26.1

**Changed:** The `version` global argument now defaults to the Snyk REST API version `2026-09-09` (was `2024-10-15`). Models that set `version` explicitly keep their value.

**Fixed:** `delete_projects_collection` (the DELETE on a collection's projects relationship) dropped its request body, so the API never learned which projects to remove. It now sends the `data` argument.

**Upgrade note:** The default API version change takes effect for models that rely on it. Pin `version` to `2024-10-15` to keep the old API behavior. Stored data is unchanged.
