## 2026.08.21.1

**Changed:** Added descriptions to every previously undocumented field across
the `activities`, `organizations`, `users`, `roles`, `groups`,
`groupMembers`, and `effectiveSettings` resource schemas. No behavioral
change.

## 2026.07.30.1

**Fixed:** `sync_groups` and `sync_directory` returned HTTP 404 from the
Anthropic Compliance API. The org-scoped groups endpoint
(`/v1/compliance/organizations/{orgId}/groups`) no longer exists; groups are
now served at the top-level path `/v1/compliance/groups`.

**Changed:** All three call sites that listed groups (`sync_groups`,
`sync_directory`, and the name-lookup fallback in `get_group_members`) now
use `/v1/compliance/groups` instead of the former org-scoped path.

**Upgrade note:** No action required. The resource schema and instance names
are unchanged — only the upstream API path differs. Re-run `sync_groups` or
`sync_directory` after upgrading to populate the groups resource.
