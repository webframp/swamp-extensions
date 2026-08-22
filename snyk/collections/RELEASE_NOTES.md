## 2026.08.21.2

**Changed:**

- Snyk API request failures now name the HTTP method and path that was
  attempted (e.g. `Snyk API POST /orgs/{orgId}/collections/{id}/relationships/
  projects failed with HTTP 403: ...`) instead of surfacing only the raw
  status and body. Network-level failures (DNS, timeout, connection reset) are
  also caught and re-raised with the same context and the original error
  preserved as `cause`, rather than propagating an unlabeled fetch error.
- `update_collection_with_projects` and `delete_projects_collection` now
  reject an empty project list with a clear local validation error instead of
  sending a no-op request to the Snyk API.

**Upgrade note:** No changes to stored resource schemas. Existing instances
need no migration.
