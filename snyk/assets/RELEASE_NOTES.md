## 2026.08.21.2

**Changed:** Snyk API request failures now name the HTTP method and path that
was attempted (e.g. `Snyk API GET /orgs/{orgId}/assets failed with HTTP 403:
...`) instead of surfacing only the raw status and body. Network-level
failures (DNS, timeout, connection reset) are also caught and re-raised with
the same method/path context and the original error preserved as `cause`,
rather than propagating an unlabeled fetch error.

**Upgrade note:** No changes to stored resource schemas. Existing instances
need no migration.
