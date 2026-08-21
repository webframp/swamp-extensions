## 2026.08.21.1

**Changed:** Added `.describe(...)` documentation to previously undocumented
fields in `CategorySchema`, `TopicSchema`, `TopicDetailSchema`,
`CategoriesResultSchema`, `TopicsResultSchema`, and `SearchResultSchema`.
Tightened `host` in `GlobalArgsSchema` to require a non-empty string — an
empty hostname can never resolve to a real Discourse instance. No behavioral
changes.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `discourse.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.
