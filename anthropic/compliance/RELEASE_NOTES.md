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
sync_directory (fan-out), sync_effective_settings, collect_activities.
Seven versioned resource specs for CEL queries.
