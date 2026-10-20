# @webframp/anthropic/admin

Manage the people in a Claude Enterprise organization through the Admin API
user-management endpoints.

## What it does

- **Observe** members and their organization roles, custom roles, and RBAC
  groups with attached roles, `source_type`, members, and member counts by
  organization role, plus per-role coverage (`role_coverage`: distinct members
  of the groups carrying each custom role, by organization role).
- **Add members to a group**, selected by organization role from the live
  roster or by explicit user IDs.
- **Switch members between User and Custom** (`user` and `managed`), selected
  the same way, with each member's previous role recorded for rollback.

Custom roles attach to groups, never to people, and only in claude.ai
organization settings. To give members a custom role, put them in a group that
carries it.

## Authentication

Requires an Admin API key (`sk-ant-api01-...`). The primary owner creates it in
claude.ai → Organization settings → API → Keys → **+ Create key**, for all
linked organizations, with these scopes:

| Scope               | Used by                                                |
| ------------------- | ------------------------------------------------------ |
| `read:members`      | every method (member roster, custom roles)             |
| `read:rbac_groups`  | `sync_access`, both write methods                      |
| `write:rbac_groups` | `add_group_members`; `set_member_roles` with `managed` |
| `write:members`     | `set_member_roles`                                     |

## Quick start

```bash
swamp extension pull @webframp/anthropic/admin
swamp vault put anthropic ADMIN_KEY
swamp model create @webframp/anthropic/admin claude-admin \
  --global-arg 'adminKey=${{ vault.get("anthropic", "ADMIN_KEY") }}'

swamp model method run claude-admin sync_access
```

## Switching members whose groups already carry the role

When every member is already in some group that carries the role (often
identity-provider groups), no adds are needed. `requireRoleId` switches a
member only if they are in at least one group carrying that role:

```bash
swamp model method run claude-admin set_member_roles \
  --input role=managed --input 'fromRoles:json=["user"]' \
  --input requireRoleId=rbac_role_...
# Apply with --input dryRun=false
```

The method refuses if any group's role data is unavailable or no group carries
the role, lists members in no such group under `skippedNotInGroup`, and
re-derives the covering groups on every re-read, so a group that loses the
role mid-run stops covering its members. Verify afterwards with
`sync_access`: `role_coverage[<roleId>].managed` should equal the roster's
`roleCounts.managed`.

## Safe ordering: group first, then role

A Custom member gets only the permissions of the roles on their groups. Add
members to the group before changing their role. Both methods are dry runs
until you pass `dryRun=false`:

```bash
# 1. Every User and Custom member into the group: dry run, then apply
swamp model method run claude-admin add_group_members \
  --input groupId=rbac_group_... --input expectRoleId=rbac_role_... \
  --input 'roles:json=["user","managed"]'
swamp model method run claude-admin add_group_members \
  --input groupId=rbac_group_... --input expectRoleId=rbac_role_... \
  --input 'roles:json=["user","managed"]' --input dryRun=false

# 2. User → Custom, only for members in the group: dry run, then apply
swamp model method run claude-admin set_member_roles \
  --input role=managed --input requireGroupId=rbac_group_... \
  --input expectRoleId=rbac_role_... --input 'fromRoles:json=["user"]'
swamp model method run claude-admin set_member_roles \
  --input role=managed --input requireGroupId=rbac_group_... \
  --input expectRoleId=rbac_role_... --input 'fromRoles:json=["user"]' \
  --input dryRun=false
```

`set_member_roles` with `role: managed` requires coverage: `requireGroupId`
with `expectRoleId`, or `requireRoleId` (above). With a group, it refuses one
that does not carry the role and skips (and reports) anyone not in the group.
After every 100 attempted writes it re-reads the group, re-verifies that it
still carries `expectRoleId` (stopping the run if not), and re-reads its
membership, so running the steps out of order changes nobody. Between
re-reads, a role detached in claude.ai mid-run can still let up to 99 more
members switch before the run stops.

## Audit records and rollback

Every run writes a record. Dry runs and applies use separate instances, and
each run adds a version (up to 1,000 kept per instance):

- `add:<groupId>:dryrun` / `add:<groupId>:apply` (`groupMemberChanges`)
- `roles:<role>:dryrun` / `roles:<role>:apply` (`roleChanges`)

A later dry run never becomes the latest apply record. Earlier runs are older
versions of the same instance: `swamp data versions claude-admin roles:managed:apply`.

`changed` in a role record holds each member's `previousRole`; so do the
entries in `failed`, including those whose outcome is `unknown`. Restore
members with explicit IDs:

```bash
swamp model method run claude-admin set_member_roles --input role=user \
  --input 'userIds:json=["user_...","user_..."]' --input dryRun=false
```

## Behavior notes

### Only user and managed members are targeted

The API cannot modify `owner`, `primary_owner`, or `membership_admin`.
Selecting any role other than `user` or `managed` is an error; explicit user
IDs holding another role are skipped and listed under `skippedIneligible`.

### Direct groups only for adds

Groups provisioned by your identity provider (`source_type: scim`) are
read-only through the API. `add_group_members` refuses them. Pass
`expectRoleId` to refuse a group that does not carry the role you mean to
grant. A group whose role data is temporarily unavailable (`role_ids: null`)
is an error to retry, not "no roles".

### Rate limit, retries, and timeouts

The Admin API allows 100 requests per minute per organization, shared by every
caller. Requests are paced to `requestsPerMinute` (default 80). Each request
times out after 30 seconds. 429, 5xx, and no-response failures are retried up
to five times, honoring `retry-after` (including `0`); a `retry-after` over
five minutes fails the request instead. At 80/min, 1,500 changes take about
19 minutes.

### Failures

Each write is attempted per member; failures are collected under `failed` with
`outcome: failed` (the API rejected it with a 4xx) or `outcome: unknown` (no
response, a 5xx after retries, a cancel after the request was sent, or an
unexpected response — the change may have been applied). A cancel before a
request is sent records nothing for that member. A group add retried after a
lost response, then answered "already a member", is recorded under `added`:
the first attempt applied it. Duplicate group-member rows
are collapsed. The method throws after writing its record, so the record of what
changed is kept. The run stops at once on 401 or 403, and after three
consecutive identical failures (for example, roles managed by the IdP),
however many writes succeeded before. `aborted` says why.

### Partial reads are refused

A member or group listing without a `data` array, a member page without a
boolean `has_more`, `has_more` without a cursor that advances, or a repeating
cursor all throw instead of acting on a partial roster. Every list is capped
at 50 pages (50,000 rows); a larger list throws rather than truncating.
