## 2026.11.05.3

**Fixed:** `sync_teams` no longer writes an empty resource under a constant
`"created"` instance name. The endpoint returns no content on success, so there
is nothing to persist — the method now issues the link call and returns no data
handles, and the `sync_teams` resource spec is removed. The request body is also
sent in the correct JSON:API envelope
(`{data: {type: "team_sync_bulk", attributes: {...}}}`) the endpoint expects.

**Upgrade note:** `sync_teams` previously stored an empty `{}` resource on every
call; it now stores nothing. No other method is affected.

## 2026.11.05.1

**Changed:** Regenerated from the current Datadog OpenAPI spec. Team schemas
gain optional `handles`, `is_open_membership`, and `provisioned_by` fields. The
team-sync and team-connection `source`/`type` enums now accept `servicenow`
(alongside the existing `github`) and `servicenow_team` (alongside
`github_team`). Several field descriptions were clarified. No methods were added
or removed.

**Upgrade note:** Additive only — new fields are optional and the enum changes
only widen the accepted set, so existing stored data continues to validate. No
migration required.

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README now shows how to store the API key and application key
in a `datadog` vault and wire them with `${{ vault.get("datadog", "API_KEY") }}`
and `${{ vault.get("datadog", "APP_KEY") }}`. The previous example passed
`DD_API_KEY` and `DD_APP_KEY` as literal global arguments, which swamp rejects
for sensitive arguments.

**Changed:** The `apiKey` and `appKey` descriptions now say to supply them with
a `vault.get` expression. Both were already marked sensitive.

**Upgrade note:** Documentation and argument descriptions only. Methods,
arguments, resource schemas and stored data are unchanged.
