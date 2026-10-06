## 2026.10.06.1

**Bug fix:** `collect_activities` now honors the `activity_types` filter. It
previously sent a bare `activity_types` query parameter, which the Compliance
API rejects with HTTP 400; it now sends repeated `activity_types[]` values.
The comma-separated argument is split and trimmed, and empty entries are
dropped. Example names in the docs now use real activity types such as
`claude_chat_created` and `github_integration_updated`.

## 2026.09.18.1

**Upgrade note:** Normalized `npm:zod` dependency version to 4.6.5 across the
repo. No behavioral changes in this extension.
