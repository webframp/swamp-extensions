# @webframp/microsoft/teams

Read-only Microsoft Teams integration via the Graph API. Uses a public client
app registration with device code flow authentication — no client secret
required.

## Methods

| Method             | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `bootstrap`        | Device code flow auth; outputs refresh token for vault   |
| `list_teams`       | Enumerate Teams the signed-in user belongs to            |
| `list_channels`    | List channels in a team                                  |
| `channel_messages` | Fetch channel messages with threaded replies (paginated) |
| `list_chats`       | List recent 1:1 and group chats with read state          |
| `chat_messages`    | Fetch messages from a specific chat                      |
| `attention`        | Aggregate unread chats and @mentions within a window     |

## Setup

```bash
# Store credentials in vault
swamp vault put my-vault tenantId "e9b2b7ba-..."
swamp vault put my-vault clientId "3f98c5a4-..."
swamp vault put my-vault refreshToken "placeholder"

# Create the model
swamp model create @webframp/microsoft/teams my-teams

# Authenticate via device code
swamp model method run my-teams bootstrap
# Follow the prompts, then store the output refresh token:
swamp vault put my-vault refreshToken "<token from bootstrap output>"
```

## Usage

```bash
# List teams
swamp model method run my-teams list_teams

# List channels in a team
swamp model method run my-teams list_channels --input teamId=<team-id>

# Fetch recent channel messages with replies
swamp model method run my-teams channel_messages \
  --input teamId=<team-id> \
  --input channelId=<channel-id> \
  --input limit=20

# Check for unread chats and @mentions (last 24h)
swamp model method run my-teams attention

# Only unread chats, scanning the 100 most recent (skips the mention scan
# and the extra /me lookup it requires)
swamp model method run my-teams attention \
  --input mode=unread_only --input chatLimit=100

# List chats, filtered to a member's name or email substring
swamp model method run my-teams list_chats --input nameFilter=jane

# Fetch chat messages since a timestamp
swamp model method run my-teams chat_messages \
  --input chatId=<chat-id> \
  --input since=2026-08-20T00:00:00Z

# Query stored data
swamp data query my-teams 'attributes.totalItems > 0'
```

## Authentication

This extension uses the `appsvc_teams_data_client` public client app
registration. Delegated scopes: `offline_access`, `User.Read`,
`Team.ReadBasic.All`, `Group.Read.All`, `ChannelMessage.Read.All`, `Chat.Read`.

Refresh tokens rotate on each use and expire after 90 days of inactivity. If
any method returns `invalid_grant`, re-run `bootstrap`.

## Troubleshooting

**`bootstrap` fails with `device_code_expired`.** `pollDeviceCode` polls until
the device code's own `expires_in` deadline (from Entra, typically ~15
minutes) — if you don't finish the browser sign-in before that, the method
throws `MicrosoftAuthError("device_code_expired", ...)` rather than hanging.
Re-run `bootstrap` and complete the verification URL promptly this time.

**Any method fails with `invalid_grant`.** `refreshAccessToken` in
`_lib/auth.ts` throws this specific error code when the stored refresh token
has expired (90 days of inactivity) or been revoked (e.g. a password change).
Every other OAuth error surfaces with its raw Graph error code/description
instead — `invalid_grant` is the one case worth recognizing on sight, since
the fix is always the same: re-run `bootstrap` and update `refreshToken` in
the vault.

**`channel_messages` returns `truncated: true` with fewer messages than
expected.** Root-message pagination is capped at `MAX_CHANNEL_PAGES = 5`
pages of 50 (250 messages scanned), and the loop also stops once `limit`
user messages have been collected. On a channel with a lot of system
messages (adds/removes, renames) interleaved with real messages, the 5-page
cap can be hit before `limit` user messages are found — `truncated` reflects
either condition, so check it before assuming the channel is quiet.

**`list_chats --input nameFilter=...` returns fewer chats than `limit`, or
`truncated: true`, even though matches exist.** The name/email filter is
applied client-side after fetching (Graph has no server-side "member name
contains" filter), so the method over-fetches at `limit * 5` per page
(capped at 50) across up to `MAX_CHAT_PAGES = 10` pages. If matches are
sparse across your chat history, the fetch can hit the 10-page cap before
finding `limit` matching chats — `truncated: true` means more chats may
exist beyond what was scanned, not that the filter is broken.

**Every Graph call error is prefixed with the operation and IDs involved.**
`withGraphContext` wraps every request and rethrows as
`` `<operation>: <original message>` `` with the underlying `GraphApiError`
(HTTP status + Graph error code) or network error preserved as `.cause`. If
a call fails with something like `Authorization_RequestDenied` in the
message, the app registration is missing admin consent for one of the scopes
listed above (commonly `Group.Read.All` or `ChannelMessage.Read.All`), not a
token problem — re-running `bootstrap` will not fix it.
