## 2026.08.21.1

**Changed:** When a source (HN, Lobste.rs, SRE Weekly, IFIN Discourse, RedMonk,
arXiv, or The AI Daily Brief) fails to gather, `gather` now logs the source
name and the underlying error message before falling back to an empty result
for that source. Previously the failure was discarded silently, so a brief
with `hnFrontPage.stories: []` gave no clue whether HN genuinely had nothing
new or the fetch failed. `gather` still returns partial data on a single
source failure — that behavior is unchanged.

**Upgrade note:** No schema changes. Existing instances need no migration.
