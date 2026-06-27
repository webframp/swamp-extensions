## 2026.06.27.1

**Added:** `get_channel` now includes live stream detection. Three new fields in the channel resource: `isLive` (boolean, default false), `viewerCount` (number|null, default null), `startedAt` (ISO timestamp|null, default null). Uses the Twitch Streams API — no additional scopes required.

**Upgrade note:** New fields use Zod defaults so previously stored channel resources remain valid on read. Existing model instances work without reconfiguration. Re-run `get_channel` to populate the new fields.
