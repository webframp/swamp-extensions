## 2026.08.21.2

**Changed:** `topicId`, `categoryId`, and page numbers are now required to be positive integers (topicId/categoryId) or non-negative integers (page) instead of any number — a fractional or negative ID used to sail through validation and fail later with a confusing 404 from the Discourse API. `slug` in `list_category_topics` must now be non-empty. `list_categories`, `list_latest`, and `list_category_topics` now check the shape of the Discourse response before reading into it: an unexpected JSON body (a misconfigured proxy, an HTML error page served as `200`, an API version change) used to crash with a bare "Cannot read properties of undefined" pointing nowhere useful; it now raises an error naming the request that was made and a preview of what was actually returned.

## 2026.08.21.1

**Changed:** Added `.describe(...)` documentation to previously undocumented
fields in `CategorySchema`, `TopicSchema`, `TopicDetailSchema`,
`CategoriesResultSchema`, `TopicsResultSchema`, and `SearchResultSchema`.
Tightened `host` in `GlobalArgsSchema` to require a non-empty string — an
empty hostname can never resolve to a real Discourse instance. No behavioral
changes.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `discourse.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.
