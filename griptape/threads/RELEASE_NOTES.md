## 2026.11.07.1

**Added:** Message-level methods for the `/api/messages/{message_id}` endpoints
(get, update, and delete a single message by ID), which previously had no
extension coverage. Existing methods, arguments, and resource schemas are
unchanged.

**Upgrade note:** Additive only; stored data continues to validate. No migration
required.
