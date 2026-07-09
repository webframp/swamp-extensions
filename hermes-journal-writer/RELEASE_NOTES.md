## 2026.07.08.1

**Changed:** One org file per day instead of a monthly rollup.

- Journal entries are now written to `YYYY-MM-DD-dow.org` (e.g.
  `2026-07-08-wed.org`), each a standalone org document with `#+TITLE`,
  `#+DATE`, and `#+FILETAGS` headers. Writing is idempotent — an existing
  file for the day is left untouched.
- Section headings are now level-1 (`* Hacker News`) since the day's entry is
  the whole document, rather than the `***`/`****` levels that assumed nesting
  inside a monthly file.
- `#+FILETAGS` are now joined with single colons (`:a:b:`); the previous join
  emitted a doubled colon (`:a::b:`) that org parses as an empty tag. Tags that
  sanitize to an empty string are dropped rather than emitted.
- A run with no research data now writes and commits nothing (status
  `skipped-no-data`) instead of committing a "No research data" placeholder.
  The placeholder would trip the idempotency guard and permanently block a
  later run that day from writing the real entry once the collector had run.

**Added:**

- `sources` global arg — an array drawn from
  `["hn", "lobsters", "sre", "ifin", "redmonk", "arxiv"]`. Defaults to all
  sources; remove a name to disable that source. An unset/empty value is
  treated as "all sources".
- arXiv entries are now rendered as an `* arXiv` section (previously collected
  but never written out).

**Fixed:**

- Git failures are no longer reported as success. The recorded status now
  reflects what actually reached the remote: `written` (committed and pushed),
  `committed-not-pushed` (push failed), `written-not-committed` (commit failed),
  or `written-nothing-to-commit` (the file already matched the last commit, so
  no push was attempted). A failed `git status` (e.g. a held `index.lock`) is
  treated as an error rather than "nothing to commit".
- The commit now stages and commits only the day's file (`git add -- <file>`)
  rather than the whole journal subdirectory, so an unrelated in-progress edit
  is never swept into the bot commit.
- The idempotency guard now rethrows non-`NotFound` `stat` errors (permission
  denied, I/O) instead of swallowing them and failing later without context.
- `runCommand` clears its timeout timer in a `finally` block, so the timer no
  longer leaks if the subprocess call rejects.
- Reads the `research` data spec first (the current
  `@webframp/research-collector` output), falling back to the legacy `brief`
  spec for older instances.
