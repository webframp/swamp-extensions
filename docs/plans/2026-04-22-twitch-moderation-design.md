# Twitch Moderation Extension Design

**Goal:** Build a swamp extension that gives Twitch moderators cross-channel
visibility into chat activity, user history, and moderation events — then
surface suspicious users and ban overlap through a workflow and report.

**Architecture:** A single model type (`@webframp/twitch`) where each instance
represents one channel the moderator manages. A workflow fans out across
channel instances to gather data, and a report correlates findings
cross-channel.

**Tech Stack:** TypeScript/Deno, Twitch Helix REST API, OAuth2 user tokens,
swamp vault for credential storage.

---

## Model: `@webframp/twitch`

### Instance Pattern

One model instance per channel:

```bash
swamp model create @webframp/twitch mod-drongo \
  --global-arg channel=drongo \
  --global-arg moderatorId=12345678
```

### Global Args

| Arg | Description |
|-----|-------------|
| `channel` | Broadcaster's login name |
| `moderatorId` | Your Twitch user ID (the authenticated moderator) |

### Auth via Vault Expressions

| Arg | Vault Key |
|-----|-----------|
| `clientId` | `${{ vault.get("twitch-client-id") }}` |
| `clientSecret` | `${{ vault.get("twitch-client-secret") }}` |
| `accessToken` | `${{ vault.get("twitch-access-token") }}` |
| `refreshToken` | `${{ vault.get("twitch-refresh-token") }}` |

### Methods

| Method | Twitch Endpoint | Purpose |
|--------|----------------|---------|
| `get_channel` | Get Channel Information | Channel metadata: title, game, tags |
| `get_chatters` | Get Chatters | Current users in chat |
| `get_user` | Get Users | Account age, profile for a specific user |
| `get_banned_users` | Get Banned Users | Current bans and timeouts |
| `ban_user` | Ban User | Ban or timeout a user |
| `unban_user` | Unban User | Remove a ban/timeout |
| `get_mod_events` | Get Moderation Events | Recent mod actions log |

### Token Refresh

The model handles refresh transparently. On a 401 response, it exchanges the
refresh token for a new access token using the client credentials, then retries
the original request. If the refresh token itself is expired (unused for 30+
days), the method fails with a clear error directing the user to re-authorize.

### Rate Limiting

Twitch allows 800 requests per minute per access token. The model reads
`Ratelimit-Remaining` and `Ratelimit-Reset` response headers and pauses if
approaching the limit.

---

## Data Outputs

### `get_chatters`

```typescript
{
  channel: string;
  chatters: Array<{
    userId: string;
    login: string;
    displayName: string;
  }>;
  count: number;
  fetchedAt: string;
}
```

### `get_user`

```typescript
{
  userId: string;
  login: string;
  displayName: string;
  accountCreatedAt: string;
  accountAgeDays: number;     // Pre-computed for easy filtering
  profileImageUrl: string;
  broadcasterType: string;
  fetchedAt: string;
}
```

### `get_banned_users`

```typescript
{
  channel: string;
  bans: Array<{
    userId: string;
    login: string;
    reason: string;
    moderatorLogin: string;
    createdAt: string;
    expiresAt: string | null;  // null = permanent ban
  }>;
  count: number;
  fetchedAt: string;
}
```

### `get_channel`

```typescript
{
  broadcasterId: string;
  broadcasterLogin: string;
  broadcasterName: string;
  gameName: string;
  gameId: string;
  title: string;
  tags: string[];
  fetchedAt: string;
}
```

### `get_mod_events`

```typescript
{
  channel: string;
  events: Array<{
    eventType: string;       // e.g., "moderation.user.ban"
    eventTimestamp: string;
    userId: string;
    userLogin: string;
    moderatorLogin: string;
  }>;
  count: number;
  fetchedAt: string;
}
```

---

## Workflow: `@webframp/twitch-mod-audit`

Cross-channel moderation audit. Gathers data from all channel instances in
parallel, then enriches flagged users.

### Inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `suspiciousAgeDays` | number | 7 | Flag accounts younger than this |

### Jobs

**Job 1: `gather-channel-data`** (parallel steps per channel instance)

- `get_chatters` on each channel
- `get_banned_users` on each channel
- `get_channel` on each channel

**Job 2: `enrich-flagged-users`** (depends on job 1)

- Calls `get_user` for anyone flagged by heuristics:
  - Present in chat but banned on another channel
  - Account age below threshold (requires `get_user` to check)

**Report** runs after both jobs complete.

---

## Report: `@webframp/twitch-mod-report`

Workflow-scoped report that correlates data across channel instances.

### Sections

1. **Channel Overview** — per-channel table: chatter count, active ban count,
   stream title, current game

2. **Suspicious Users** — flagged by:
   - Account age < `suspiciousAgeDays` threshold
   - Present in chat but banned on another channel you moderate
   - Appears in multiple channels simultaneously

3. **Ban Overlap** — users banned across 2+ channels, suggesting serial
   offenders worth a cross-channel permanent ban

4. **Recent Moderation Activity** — timeline of mod actions across all
   channels, useful for shift handoff

### Output

- Markdown with tables for each section
- JSON with structured findings for programmatic use

---

## Extension Structure

```
twitch/
  .swamp.yaml
  manifest.yaml
  deno.json
  extensions/
    models/
      twitch/
        mod.ts
        mod_test.ts
        _lib/
          api.ts            # Helix API client (auth, refresh, requests)
          api_test.ts
          types.ts          # Shared Twitch API types
    reports/
      mod_report.ts
      mod_report_test.ts
  workflows/
    twitch-mod-audit.yaml
```

### Testing

Mock HTTP with `withMockedFetch` (same pattern as the cloudflare extension).
Test cases:

- Each method returns correctly shaped data from mocked Helix responses
- Token refresh fires on 401, retries the original request
- Rate limit headers are respected
- Report correlates cross-channel data (suspicious users, ban overlap)
- Report handles missing/empty data gracefully

---

## OAuth2 Setup Guide

### 1. Register a Twitch Application

Go to [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) and
create a new application:

- **Name:** anything (e.g., "swamp-mod")
- **OAuth Redirect URL:** `http://localhost:3000`
- **Category:** Chat Bot

Copy the **Client ID** and generate a **Client Secret**.

### 2. Store Client Credentials in Vault

```bash
swamp vault set twitch-client-id YOUR_CLIENT_ID
swamp vault set twitch-client-secret YOUR_CLIENT_SECRET
```

### 3. Authorize with Twitch

Open this URL in your browser (replace `YOUR_CLIENT_ID`):

```
https://id.twitch.tv/oauth2/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3000&response_type=code&scope=moderator:read:chatters+moderation:read+moderator:manage:banned_users+moderator:read:blocked_terms+channel:read:editors
```

Twitch redirects to `http://localhost:3000?code=AUTHORIZATION_CODE`. Copy the
`code` parameter from the URL.

### 4. Exchange the Code for Tokens

```bash
curl -X POST 'https://id.twitch.tv/oauth2/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'client_id=YOUR_CLIENT_ID' \
  -d 'client_secret=YOUR_CLIENT_SECRET' \
  -d 'code=AUTHORIZATION_CODE' \
  -d 'grant_type=authorization_code' \
  -d 'redirect_uri=http://localhost:3000'
```

Response:

```json
{
  "access_token": "abc123...",
  "refresh_token": "def456...",
  "expires_in": 14400,
  "scope": ["moderator:read:chatters", "moderation:read", "..."],
  "token_type": "bearer"
}
```

### 5. Store Tokens in Vault

```bash
swamp vault set twitch-access-token ACCESS_TOKEN_FROM_RESPONSE
swamp vault set twitch-refresh-token REFRESH_TOKEN_FROM_RESPONSE
```

### 6. Get Your Moderator User ID

```bash
curl -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -H 'Client-Id: YOUR_CLIENT_ID' \
  'https://api.twitch.tv/helix/users'
```

The `id` field in the response is your `moderatorId` for model creation.

### Token Refresh (Automatic)

The model refreshes expired tokens automatically. For reference, the refresh
request looks like:

```bash
curl -X POST 'https://id.twitch.tv/oauth2/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'client_id=YOUR_CLIENT_ID' \
  -d 'client_secret=YOUR_CLIENT_SECRET' \
  -d 'refresh_token=YOUR_REFRESH_TOKEN' \
  -d 'grant_type=refresh_token'
```

If the refresh token expires (unused for 30+ days), re-run steps 3–5.

---

## Scope

### v1 (In Scope)

- `@webframp/twitch` model with 7 methods
- Token refresh on 401 with retry
- Auth guidance with curl examples in manifest description
- `@webframp/twitch-mod-audit` workflow
- `@webframp/twitch-mod-report` cross-channel report
- Tests with mocked HTTP for all methods and the report
- CI matrix entry

### Deferred

- `get_blocked_terms` / `update_blocked_terms`
- `update_automod_settings` (high-risk write)
- Real-time chat monitoring via EventSub/WebSocket (`@webframp/twitch-chat`)
- Automated ban propagation across channels (report surfaces overlap, human decides)
- Rate limit token bucket (v1 uses simple retry-after)
- Dedicated skill document (manifest description suffices for v1)
