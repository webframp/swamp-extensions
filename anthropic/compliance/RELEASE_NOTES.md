## 2026.07.17.1

**Added:**

- New `config-snapshot` report (`@webframp/compliance-config-snapshot`),
  registered as a default report on the model type. Aggregates the latest
  `effectiveSettings`, `roles`, `groups`, and `organizations`, plus the
  directory user _count_ (never the roster), into one JSON artifact —
  `swamp report get @webframp/compliance-config-snapshot --model
  claude-compliance --json`.
  Intended to be exported into a git-tracked config repo so drift and growth are
  visible via `git log`/`git diff`. Individual users and group membership are
  deliberately excluded: that data is SCIM/Entra-owned, not config, and carries
  PII.

## 2026.07.15.1

**Fixed:**

- `sync_users`, `sync_roles`, `sync_groups`, `sync_effective_settings`, and the
  `sync_directory` fan-out all wrote their resource using the organization ID as
  the instance name. Since every one of those specs shared the same instance
  name, each sync method's write landed as a new _version_ of the same data
  artifact rather than its own resource — running `sync_roles` after
  `sync_effective_settings` silently pushed the effective settings snapshot into
  history, and `swamp data get claude-compliance
  <orgId>` would return
  whichever spec synced most recently, not a specific one.

**Changed:**

- These methods now write to a fixed instance name equal to their own spec name
  (`"users"`, `"roles"`, `"groups"`, `"effectiveSettings"`) instead of the
  organization ID, matching the existing pattern used by `collect_activities`
  (`"recent"`) and `sync_organizations` (`"all"`) — each spec's instance name is
  exclusive to that spec, since swamp's storage key is `(modelId, name)` and
  does not include `specName`. An earlier draft of this fix used a single shared
  literal (`"current"`) for all four specs, which reproduced the exact same
  collision under a different name; that was caught in review before release.
- `get_group_members` now writes to `member:<groupId>` instead of the bare
  `groupId`. Since `groupId` is caller-supplied, an unnamespaced write could
  collide with one of the new fixed literals above (e.g. a group ID of `"users"`
  would have landed on the same data name as `sync_users`).

**Upgrade note:** Data written under the old org-ID-keyed name by previous
versions is orphaned by this change — it remains in history (subject to each
resource's normal GC policy) but is no longer returned by
`swamp data
get claude-compliance <orgId>`. Re-run `sync_users`, `sync_roles`,
`sync_groups`, and `sync_effective_settings` (or `sync_directory`) after
upgrading, then read them back with `swamp data get claude-compliance
users` /
`roles` / `groups` / `effectiveSettings`. Group member data moves from
`swamp data get claude-compliance <groupId>` to
`swamp data get
claude-compliance member:<groupId>` — update any CEL expressions
or scripts referencing the old form.

## 2026.07.07.1

**Fixed:**

- `collect_activities` `since` filter: the Compliance API expects the dotted
  range parameter `created_at.gte`, not the bracketed `created_at[gte]`, which
  returned HTTP 400 (`Unknown query parameter: 'created_at[gte]'`). The `since`
  argument now filters activities correctly.

## 2026.07.03.1

**Fixed:**

- Organization ID mapping: The Anthropic compliance API returns org identifiers
  in the `uuid` field, not `id`. `resolveOrgId` and `sync_organizations` now
  correctly prefer `uuid` over `id`, fixing auto-discovery failures.
- Activity schema: `actor.id`, `actor.email`, `actor.name`, and `details` are
  now nullable+optional, matching actual API response shapes (e.g. `api_actor`
  has `api_key_id` but no `id`/`email`/`name`).

**Changed:**

- `collect_activities` now writes to the `"recent"` instance (was `"latest"`).
  swamp reserves `"latest"` for internal use. **If you have CEL expressions
  referencing `data.latest("claude-compliance", "latest")`, update them to
  `data.latest("claude-compliance", "recent")`.**

## 2026.07.02.1

**Added:** Initial release. Compliance API observation model with 8 methods:
sync_organizations, sync_users, sync_roles, sync_groups, get_group_members,
sync_directory (fan-out), sync_effective_settings, collect_activities. Seven
versioned resource specs for CEL queries.
