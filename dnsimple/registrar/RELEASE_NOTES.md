## 2026.11.03.2

Fixed: transfer_domain no longer requires auth_code. DNSimple's own description
limits it to TLDs that use authorization-based transfers, so a transfer for any
other TLD was rejected before a request was sent. DNSimple still refuses a
transfer that needs a code and does not get one.

Changed: list methods store truncated: true when a response reports more pages
than were fetched, instead of always storing false. Nothing changes for lists
DNSimple returns in one page.
