## 2026.08.14.1

**Added:** `update_issue` now accepts `assignedToId: null` to clear the
assignee. Passes `""` to the Redmine API (their convention for unsetting a
field). Previously only `number` was accepted, making unassignment impossible
through the extension.

## 2026.08.10.1

**Changed:** The `project` global argument is now optional. This enables
cross-project queries — most notably `list_issues` with `assignedToId: "me"`
across all accessible projects, equivalent to Redmine's `/my/page` view.

- `list_issues` and `search` operate across all projects when no project is
  specified (neither as a method argument nor globally).
- Methods that require a project in their URL path (`list_users`,
  `create_issue`, `list_versions`, `create_version`, `list_issue_categories`)
  throw a clear error if none is resolved from either source.
- Instance names for `list_issues` now include all active filter fields with
  prefixes (`p:`, `a:`, `s:`, `t:`, `parent:`) to prevent cache collisions
  between different filter combinations.

**Upgrade:** Existing model instances with `project` set continue to work
unchanged. The upgrade is a no-op identity function (no persisted data
migration needed). New instances may omit `project` for cross-project queries.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `redmine.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.

## 2026.07.09.1

**Fixed:** Extension failed to load with `Last upgrade toVersion "2026.06.21.1"
does not match model version "2026.07.08.1" for model type
"@webframp/redmine"`. #194 bumped the model's `version` field to match the
manifest but never added a matching `upgrades` entry, leaving the upgrade
chain one version short of the declared model version — a rule the registry
enforces at load time. This adds the missing no-op upgrade entry and bumps the
version again so the chain is complete. No behaviour change beyond #194.
