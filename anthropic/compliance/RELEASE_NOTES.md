## 2026.08.21.2

**Changed:** `collect_activities`'s `since` argument is now validated as a
parseable timestamp before being sent to the API — previously a malformed
value passed straight through and only surfaced as an opaque upstream 400.

`get_group_members`'s best-effort group-name lookup no longer swallows its
failure silently; a failed lookup now logs a message naming the group ID and
the underlying error before falling back to using the ID as the display name.

The config-snapshot report's data reads no longer treat a storage-backend
failure and "this spec was never collected" identically. A failed
`getContent` call or unparseable JSON now logs a warning naming the spec and
model instance before the report falls back to omitting that section.
