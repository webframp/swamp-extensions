## 2026.11.03.4

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.11.03.3

Fixed: a result named from two path values, such as a record under a zone, could
share a name with a result named from one value. Those names now end in a
16-character hash, for example example.com-12345-<hash>. Results stored under
the old name stay where they are and are not updated.

Fixed: the DNS analytics result type no longer lists the string type twice in a
union. Parsing behaves as before.

Changed: list methods store truncated: true when a response reports more pages
than were fetched, instead of always storing false. Nothing changes for lists
DNSimple returns in one page.
