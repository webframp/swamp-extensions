# @webframp/microsoft

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

# Query stored data
swamp data query my-teams 'attributes.totalItems > 0'
```

## Authentication

This extension uses the `appsvc_teams_data_client` public client app
registration. Delegated scopes: `offline_access`, `User.Read`,
`Team.ReadBasic.All`, `Group.Read.All`, `ChannelMessage.Read.All`, `Chat.Read`.

Refresh tokens rotate on each use and expire after 90 days of inactivity. If
any method returns `invalid_grant`, re-run `bootstrap`.
