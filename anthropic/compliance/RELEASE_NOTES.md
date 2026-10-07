## 2026.10.07.1

**Bug fix:** `sync_users`, `sync_directory` and `get_group_members` failed with
HTTP 400 (`Unknown query parameter: 'after_id'`). The directory endpoints page
with an opaque `next_page` token passed back as `page`; the extension sent the
activity feed's `after_id` cursor. Pagination now follows `next_page`, and
`sync_roles`, `sync_groups` and `sync_directory` follow it too instead of
reading only the first page.

User records now read `full_name` and `organization_role` (the fields the API
returns) into the existing `name` and `role` attributes, which were previously
always empty. Group members use `user_id` as `id`.

**Feature:** `collect_activities` can now target one user's history and walk
back through the feed:

- `actor_ids` filters by directory user ID (comma-separated; IDs come from
  `sync_users`).
- `until` bounds the window above, alongside the existing `since`.
- `max_pages` follows `has_more` through older pages (default 1, max 50).
- `after_id` resumes from the `next_cursor` a previous run stored.

The activity resource gains optional `next_cursor`, `pages` and `filters`
fields (a cursor is only valid for the same filters), and the actor schema now
includes `user_id` and `email_address`, the keys the API uses on `user_actor`
records. No breaking schema changes.

**Behavior changes in `collect_activities`:**

- `since` and `until` must be ISO-8601 and are normalized to UTC
  (`2026-10-01T02:00:00+02:00` is sent as `2026-10-01T00:00:00.000Z`). A
  date-only value means 00:00Z that day. A value with a time must carry `Z` or
  an offset, since otherwise the window would depend on the host's timezone.
  Impossible dates such as `2026-02-31`, years outside 1970–9998, and an `until`
  earlier than `since` are rejected.
- `limit` and `max_pages` must be positive integers. A non-numeric or
  non-positive value now fails with a clear error instead of being forwarded
  or silently replaced by the default.
- A cursor that does not advance ends the walk instead of repeating requests.
  The output then keeps `has_more: true`, sets `stalled: true` and leaves
  `next_cursor` null, so a truncated feed is never reported as complete.

**Truncation reporting:** directory reads report `has_more: true` whenever data
may remain unread: the 20-page cap was reached, the API claimed more data
without a usable `next_page`, or the token repeated. `get_group_members` now
pages the group list when resolving the group name, records `has_more`, and
URL-encodes the group ID. `sync_directory` now fetches users, roles and groups
before writing any of them, so a failure partway through leaves no partial
update. The config-snapshot report marks the directory user
count `truncated`, and adds `rolesTruncated` / `groupsTruncated` flags, when a
list was cut short.

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
