## 2026.06.27.1

**Added:** `get_channel` now includes live stream detection. Three new fields in the channel resource: `isLive` (boolean), `viewerCount` (number, null when offline), `startedAt` (ISO timestamp, null when offline). Uses the Twitch Streams API — no additional scopes required.

**Upgrade note:** Schema is additive. Existing model instances work without reconfiguration.
