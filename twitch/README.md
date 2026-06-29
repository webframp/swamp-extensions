# @webframp/twitch

Twitch Moderation Toolkit for [swamp](https://github.com/systeminit/swamp) —
cross-channel moderation visibility for Twitch moderators.

One model instance per channel you moderate. Includes a workflow that audits all
channels in parallel and a report that correlates findings cross-channel to
surface suspicious users and ban overlap.

## Quick Start

```bash
swamp extension pull @webframp/twitch

# Create one model instance per channel you moderate
swamp model create @webframp/twitch mod-drongo \
  --global-arg channel=drongo \
  --global-arg moderatorId=YOUR_TWITCH_USER_ID \
  --global-arg 'clientId=${{ vault.get("twitch-creds", "twitch-client-id") }}' \
  --global-arg 'clientSecret=${{ vault.get("twitch-creds", "twitch-client-secret") }}' \
  --global-arg 'accessToken=${{ vault.get("twitch-creds", "twitch-access-token") }}' \
  --global-arg 'refreshToken=${{ vault.get("twitch-creds", "twitch-refresh-token") }}'

# Check chatters in a channel
swamp model method run mod-drongo get_chatters --json

# Run the cross-channel audit
swamp workflow run @webframp/twitch-mod-audit
```

## Authentication

Requires a Twitch application with OAuth2 user tokens. Register an app at
[dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) with redirect
URL `http://localhost:3000` and category "Chat Bot".

Store credentials in a swamp vault:

```bash
swamp vault put twitch-creds twitch-client-id YOUR_CLIENT_ID
swamp vault put twitch-creds twitch-client-secret YOUR_CLIENT_SECRET
swamp vault put twitch-creds twitch-access-token YOUR_ACCESS_TOKEN
swamp vault put twitch-creds twitch-refresh-token YOUR_REFRESH_TOKEN
```

The model auto-refreshes expired access tokens using the refresh token.

## Scopes

| Scope | Used by | Purpose |
|-------|---------|---------|
| moderator:read:chatters | get_chatters | List users in chat |
| moderation:read | get_banned_users, get_mod_events | Read bans and mod activity |
| moderator:manage:banned_users | ban_user, unban_user | Issue bans/timeouts and unban |
| user:write:chat | send_message | Send chat messages as your user |
| channel:read:editors | get_channel | Read channel metadata + live status |

## Methods

- **get_chatters** — List users currently in chat
- **get_banned_users** — Read bans for the channel
- **get_mod_events** — Moderator action logs
- **get_channel** — Channel metadata including live stream detection
- **ban_user** — Issue a ban or timeout
- **unban_user** — Remove a ban
- **send_message** — Send a chat message as your user
- **lookup_user** — Look up a Twitch user by login name

## Workflow

- **@webframp/twitch-mod-audit** — Audits all model instances in parallel,
  correlates bans cross-channel, and generates the moderation report.

## Report

The `@webframp/twitch/mod-report` runs after the audit workflow and produces:
- Channel overview (chatters, ban counts per channel)
- Cross-channel ban overlap (same user banned in 2+ channels)
- Suspicious users (chatting in one channel but banned in another)
- Mod event timeline
