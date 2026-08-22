## 2026.08.21.2

**Changed:**

- Snyk API request failures now name the HTTP method and path that was
  attempted (e.g. `Snyk API POST /orgs/{orgId}/apps/creations failed with HTTP
  403: ...`) instead of just the raw status and body. Network-level failures
  (DNS, timeout, connection reset) are also caught and re-raised with the same
  method/path context and the original error preserved as `cause`, rather than
  propagating an unlabeled fetch error.
- `update_group_app_install_secret`, `create_manage_app_creation_secret`, and
  `update_org_app_install_secret` now validate that `secret` is present when
  `mode` is `"create"` or `"replace"`. Previously an omitted secret in those
  modes would fail deep inside the Snyk API call with a generic 4xx error
  instead of a clear local validation message.

**Upgrade note:** No changes to stored resource schemas. Existing instances
need no migration.
