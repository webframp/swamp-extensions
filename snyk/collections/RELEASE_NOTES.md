## 2026.11.05.1

**Fixed:** `update_collection_with_projects` (a POST whose only success
response is HTTP 204) wrote an empty resource under a dead instance name. A
write whose success response carries no body now issues the API call and
returns zero data handles, persisting nothing. The `collection_with_projects`
resource is removed.

**Changed:** `update_collection_with_projects` now returns
`{ dataHandles: [] }` and no longer declares a `collection_with_projects`
resource.

**Upgrade note:** Any `collection_with_projects` resource previously written by
this method held only an empty object; it is no longer produced. No stored data
that still validates is affected.

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README now shows the Snyk API token stored in a swamp vault
(`swamp vault put snyk API_TOKEN`) and wired with
`--global-arg 'apiToken=${{ vault.get("snyk", "API_TOKEN") }}'`, replacing the
literal-token example. The `apiToken` argument description says the same.

Documentation only: nothing behavioral changed. This API returns no secrets.
