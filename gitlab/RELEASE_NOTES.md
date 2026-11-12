## 2026.11.12.1

**Added:** `get_commit` fetches one commit from a project by its full or
abbreviated SHA (at least 7 hex characters) and writes it to the new
`commitDetail` resource. The resource carries the full commit message, parent
SHAs, author and committer with their dates, line stats, and the web URL.
Looking up a commit by SHA used to need a `list_commits` call with the SHA as
`ref` and `perPage=1`, which returned only the title and author. A SHA that is
not in the project fails with GitLab's 404.

**Upgrade note:** No changes to existing schemas. The model version moves to
2026.11.12.1 with an identity upgrade.
