## 2026.11.05.1

**Fixed:** `create_assignments` (a POST) and `update_user` (a PATCH), whose only
success response is HTTP 204, wrote an empty resource under a dead instance
name. A write whose success response carries no body now issues the API call
and returns zero data handles, persisting nothing. The `user` resource is
removed.

**Changed:** `create_assignments` and `update_user` now return
`{ dataHandles: [] }`. Because `create_assignments` no longer writes, the
`assignments` resource schema is now just `ListAssignmentsSchema` (the list
wrapper) instead of a union with an empty-object member; `list_assignments`
still writes it unchanged.

**Upgrade note:** The `user` resource previously written by `update_user` held
only an empty object; it is no longer produced. The `assignments` resource
written by `list_assignments` is unchanged, so stored list data continues to
validate. No migration required.

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README now shows the Snyk API token stored in a swamp vault
(`swamp vault put snyk API_TOKEN`) and wired with
`--global-arg 'apiToken=${{ vault.get("snyk", "API_TOKEN") }}'`, replacing the
literal-token example. The `apiToken` argument description says the same.

Documentation only: nothing behavioral changed. This API returns no secrets.
