## 2026.11.03.4

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.11.03.3

Changed: list methods store truncated: true when a response reports more pages
than were fetched, instead of always storing false. Nothing changes for lists
DNSimple returns in one page.
