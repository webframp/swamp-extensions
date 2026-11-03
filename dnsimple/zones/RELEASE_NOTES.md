## 2026.11.03.2

Fixed: the DNS analytics result type no longer lists the string type twice in a
union. Parsing behaves as before.

Changed: list methods store truncated: true when a response reports more pages
than were fetched, instead of always storing false. Nothing changes for lists
DNSimple returns in one page.
