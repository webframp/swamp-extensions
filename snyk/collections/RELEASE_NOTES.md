## 2026.08.21.1

**Changed:** Schema tightening sweep — no behavioral changes.

- Added `.min(1)` to `apiToken`, `orgId`, and the collection `name` field
  (a collection cannot legitimately have an empty name).
- Added `.describe(...)` to the previously undocumented `is_generated` field
  on the collection schemas.
