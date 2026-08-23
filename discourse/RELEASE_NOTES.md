## 2026.08.23.1

**Changed:** Documentation only — no code changes. Improved the thin
`get_topic` method description and added a usage example showing how to
inspect `topicDetail.truncated`. Added a `## Troubleshooting` section
covering the `apiUsername`-required-with-`apiKey` client-side check, wrapped
`Discourse API <status>` errors (403/429 with a body snippet), the
unexpected-shape hard-fail when JSON lacks the expected list keys, what
`get_topic`'s `truncated: true` actually means (a partial `post_stream`, not
resumable pagination), and a real inconsistency: `search`'s page argument is
1-based while `list_latest`/`list_category_topics` are 0-based.
