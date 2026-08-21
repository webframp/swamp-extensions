## 2026.08.21.1

**Changed:** Added `.describe()` documentation to every previously undocumented field across
all resource schemas (teams, channels, messages, mentions, replies, chats, chat members,
viewpoints, and attention items). Tightened `tenantId`, `clientId`, and `refreshToken` in the
global arguments to require a non-empty string. No behavioral change — a no-op `upgrades`
entry was added to keep the model's `typeVersion` tracking in sync with the version bump.

## 2026.08.20.1

**Upgrade note:** Bumped zod from 4.3.6 to 4.4.3. No behavioral changes — dependency version alignment only.
