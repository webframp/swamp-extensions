# @webframp/twitch

Twitch Moderation Toolkit for [swamp](https://github.com/systeminit/swamp) —
cross-channel moderation visibility for Twitch moderators.

One model instance per channel you moderate. Includes a workflow that audits all
channels in parallel and a report that correlates findings cross-channel to
surface suspicious users and ban overlap.

## Quick Start

```bash
swamp extension pull @webframp/twitch

# Store the credentials first; see Authentication below.
# Create one model instance per channel you moderate
swamp model create @webframp/twitch mod-drongo \
  --global-arg channel=drongo \
  --global-arg moderatorId=YOUR_TWITCH_USER_ID \
  --global-arg 'clientId=${{ vault.get("twitch", "CLIENT_ID") }}' \
  --global-arg 'clientSecret=${{ vault.get("twitch", "CLIENT_SECRET") }}' \
  --global-arg 'accessToken=${{ vault.get("twitch", "ACCESS_TOKEN") }}' \
  --global-arg 'refreshToken=${{ vault.get("twitch", "REFRESH_TOKEN") }}'

# Check chatters in a channel
swamp model method run mod-drongo get_chatters --json

# Run the cross-channel audit
swamp workflow run @webframp/twitch-mod-audit
```

## Authentication

Requires a Twitch application with OAuth2 user tokens. Register an app at
[dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) with redirect
URL `http://localhost:3000` and category "Chat Bot".

Store every credential in a swamp vault and reference it with a `vault.get`
expression; never pass a literal value. Any vault type works —
`local_encryption`, or an extension such as `@webframp/pass`,
`@webframp/gopass`, `@webframp/hashicorp-vault` or `@webframp/macos-keychain`.

```bash
swamp vault create local_encryption twitch   # once, if you have no vault yet
swamp vault put twitch CLIENT_ID             # each put prompts; values never touch shell history
swamp vault put twitch CLIENT_SECRET
```

### Obtain the user tokens

1. Open this URL in a browser, with your client ID in place of `YOUR_CLIENT_ID`,
   and approve the app:

   ```text
   https://id.twitch.tv/oauth2/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3000&response_type=code&scope=moderator:read:chatters+moderator:read:banned_users+moderator:manage:banned_users+user:write:chat+channel:read:editors+moderator:read:suspicious_users+moderator:read:warnings
   ```

2. Copy the `code` parameter from the redirect URL, then exchange it for tokens
   and store them straight into the vault. The client secret travels on stdin,
   never on the `curl` command line, and the tokens are never printed:

   ```bash
   AUTH_CODE=paste-the-code-here
   TOKENS=$(printf 'client_id=%s&client_secret=%s&code=%s&grant_type=authorization_code&redirect_uri=http://localhost:3000' \
       "$(swamp vault read-secret twitch CLIENT_ID --force)" \
       "$(swamp vault read-secret twitch CLIENT_SECRET --force)" \
       "$AUTH_CODE" |
     curl -sS -X POST 'https://id.twitch.tv/oauth2/token' \
       -H 'Content-Type: application/x-www-form-urlencoded' --data @-)
   jq -r .access_token <<<"$TOKENS" | swamp vault put twitch ACCESS_TOKEN
   jq -r .refresh_token <<<"$TOKENS" | swamp vault put twitch REFRESH_TOKEN
   unset TOKENS AUTH_CODE
   ```

3. Look up your moderator user ID (the `id` field), sending the headers on
   stdin:

   ```bash
   printf 'Authorization: Bearer %s\nClient-Id: %s\n' \
       "$(swamp vault read-secret twitch ACCESS_TOKEN --force)" \
       "$(swamp vault read-secret twitch CLIENT_ID --force)" |
     curl -sS -H @- 'https://api.twitch.tv/helix/users'
   ```

`swamp vault read-secret --force` prints the plaintext secret. The commands
above only feed it into a pipe; do not run it bare in a shared terminal, and
never use it to wire a model — use `vault.get` for that.

The model auto-refreshes expired access tokens using the refresh token.

## Scopes

| Scope                         | Used by                          | Purpose                             |
| ----------------------------- | -------------------------------- | ----------------------------------- |
| moderator:read:chatters       | get_chatters                     | List users in chat                  |
| moderation:read               | get_banned_users, get_mod_events | Read bans and mod activity          |
| moderator:manage:banned_users | ban_user, unban_user             | Issue bans/timeouts and unban       |
| user:write:chat               | send_message                     | Send chat messages as your user     |
| channel:read:editors          | get_channel                      | Read channel metadata + live status |

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

## Troubleshooting

### Token refresh works per-invocation but is not persisted

On a 401 response, the extension refreshes the OAuth2 token using the refresh
token and retries once. The new access token is cached in-process but NOT
written back to vault. Each new swamp invocation starts with the original
(possibly expired) access token and refreshes again. This works as long as the
refresh token itself remains valid.

### `get_banned_users` and `get_mod_events` require broadcaster auth

These methods throw immediately if `hasBroadcasterAuth` is `false` in global
args. Set `--global-arg hasBroadcasterAuth=true` and ensure your token has
broadcaster-level scope for the target channel.

### Results silently capped at 50,000 items

The paginator stops at `MAX_PAGINATED_RESULTS = 50,000` without setting a
`truncated` field. Very large channels (100k+ chatters, heavily-banned channels)
may hit this limit without indication.

### Rate-limit self-throttling at 20 remaining

When the Twitch API's `Ratelimit-Remaining` header drops below 20, the extension
sleeps until the reset window (up to 60 seconds). This prevents 429 errors but
means methods can pause mid-execution.

### `get_mod_events` uses a deprecated endpoint

The `/moderation/moderators/events` endpoint was removed from the Twitch Helix
API. This method may return 404 or empty results on current API versions.

### No retry on 5xx errors

Server errors from Twitch throw immediately without backoff or retry. Transient
Twitch outages will crash the method invocation.
