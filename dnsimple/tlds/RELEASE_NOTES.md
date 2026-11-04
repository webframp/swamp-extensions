## 2026.11.03.4

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.11.03.3

Fixed: get_tld_extended_attributes no longer stores truncated: false
unconditionally. It stores true when the response reports more pages than were
fetched. DNSimple returns the list in one response today, so nothing changes for
current accounts.
