## 2026.11.03.3

Fixed: list_webhooks no longer stores truncated: false unconditionally. It
stores true when the response reports more pages than were fetched. DNSimple
returns every webhook in one response today, so nothing changes for current
accounts.
