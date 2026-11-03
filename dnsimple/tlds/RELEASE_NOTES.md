## 2026.11.03.2

Fixed: get_tld_extended_attributes no longer stores truncated: false
unconditionally. It stores true when the response reports more pages than were
fetched. DNSimple returns the list in one response today, so nothing changes for
current accounts.
