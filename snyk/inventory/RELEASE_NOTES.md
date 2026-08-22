## 2026.08.21.2

**Changed:**

- Snyk API request failures now name the HTTP method and path that was
  attempted (e.g. `Snyk API PATCH /groups/{groupId}/inventory/assets failed
  with HTTP 403: ...`) instead of surfacing only the raw status and body.
  Network-level failures (DNS, timeout, connection reset) are also caught and
  re-raised with the same context and the original error preserved as
  `cause`, rather than propagating an unlabeled fetch error.
- `update_assets_bulk_group` and `update_assets_bulk_org` now reject an empty
  `data` array with a clear local validation error instead of sending a no-op
  bulk update request to the Snyk API.

**Upgrade note:** No changes to stored resource schemas. Existing instances
need no migration.
