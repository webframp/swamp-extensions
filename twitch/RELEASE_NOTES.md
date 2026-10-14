## 2026.09.28.1

**Added:** Added `get_user_context` plus the
`@webframp/twitch-character-analysis` workflow, which combines observable
channel-scoped Twitch facts with typed Jev moderation rankings.

**Added:** Added a workflow report and optional outbound Discord webhook
notification. Discord Gateway ingress remains the responsibility of a small
adapter that posts signed webhook payloads to swamp.

**Upgrade note:** Configure an existing `@swamp/typesafe-ai` model with a
vault-backed TypeSafe API key. Ban status is available only when the Twitch
model has broadcaster authorization.

## 2026.09.18.1

**Fixed:** `helixApiPaginated` now sets `truncated: true` when the post-loop
cap trim actually removes items, instead of returning `truncated: false` for
a result set that is missing data.

**Upgrade note:** Normalized npm:zod reference globally to 4.6.5.
