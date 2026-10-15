## 2026.10.14.2

**Fixed:** `create_team_connections` and `delete_team_connections` now send the
`entries` array as the `data` payload. `create_team_connections` previously ran
as a paginated POST search and could re-send the request;
`delete_team_connections` sent no body and so could not delete anything.

**Changed:** `create_team_connections` is now a create method. It stores the raw
API response (`{data: [...]}`) in the `create_team_connections` resource instead
of the list-shaped `{items, truncated}` result, and its arguments changed from
none to a required `entries` array.

**Upgrade note:** The resource schema accepts both shapes, so previously stored
data still validates and no migration is needed.
