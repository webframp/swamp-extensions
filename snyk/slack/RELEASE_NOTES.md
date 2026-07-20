## 2026.07.20.2

**Fixed:** The `create_slack_default_notification_settings` and
`create_slack_project_notification_settings` methods wrote their resources under
verb-prefixed spec names, but the resource schemas are registered under the
noun-only keys `slack_default_notification_settings` and
`slack_project_notification_settings`. The writes therefore targeted undeclared
resource specs. Both methods now write to their declared specs.

**Upgrade note:** Data from these methods is now written under the noun-only
resource specs instead of the verb-prefixed names. Queries or stored resources
keyed on the old spec names should be updated.
