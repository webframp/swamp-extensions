# @webframp/reddit/moderation

Reddit moderation model for subreddit management. Provides API methods for
modqueue inspection, user reports, moderator action logs, content listing, and
moderation actions (approve, remove, ban, modmail, flair). Designed for
automated moderation pipelines that need structured access to subreddit
moderation data.

## Prerequisites

- A **Reddit "script" application** registered at
  <https://www.reddit.com/prefs/apps>. Select "script" as the app type.
- From the registered app you need:
  - **Client ID** -- the string under your app name
  - **Client Secret** -- the secret shown for the app
- A **Reddit account** with moderator permissions on the target subreddit:
  - **Username**
  - **Password**
- A descriptive **User-Agent** string (Reddit requires a unique UA for OAuth
  apps, e.g. `swamp:mymod:v1.0 (by /u/yourbot)`).

## Installation

```bash
swamp extension pull @webframp/reddit/moderation
```

## Usage

### Create the model

```bash
swamp model create @webframp/reddit/moderation reddit-mod \
  --global-arg subreddit=aoe4 \
  --global-arg clientId=vault://reddit/clientId \
  --global-arg clientSecret=vault://reddit/clientSecret \
  --global-arg username=vault://reddit/username \
  --global-arg password=vault://reddit/password \
  --global-arg userAgent="swamp:aoe4mod:v1.0 (by /u/yourbot)"
```

### Run methods

```bash
# Fetch the moderation queue (defaults to all item types)
swamp model method run reddit-mod get_modqueue

# Filter modqueue to posts only
swamp model method run reddit-mod get_modqueue --input type=posts

# Get user-submitted reports (up to 50)
swamp model method run reddit-mod get_reports --input limit=50

# View moderator action log filtered to comment removals
swamp model method run reddit-mod get_modlog --input action=removecomment

# List recent comments (up to 100)
swamp model method run reddit-mod list_comments --input limit=100

# List posts sorted by newest first
swamp model method run reddit-mod list_posts --input sort=new

# Look up information about a specific user
swamp model method run reddit-mod get_user_info --input username=targetuser

# Approve an item from modqueue
swamp model method run reddit-mod approve --input thingId=t3_abc123

# Remove a post as spam
swamp model method run reddit-mod remove --input thingId=t3_abc123 --input spam=true

# Ban a user for 7 days
swamp model method run reddit-mod ban_user --input username=spammer --input duration=7 --input banReason="Spam"

# Send modmail
swamp model method run reddit-mod send_modmail --input to=targetuser --input subject="Warning" --input body="Please follow rules"

# Apply flair to a post
swamp model method run reddit-mod flair_post --input thingId=t3_abc123 --input flairTemplateId=tmpl_xyz
```

## Methods

| Method           | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| `get_modqueue`   | Fetch items pending moderation (posts, comments, or both)    |
| `get_reports`    | Retrieve user-submitted reports for the subreddit            |
| `get_modlog`     | Query the moderator action log with optional action filter   |
| `list_comments`  | List recent comments in the subreddit                        |
| `list_posts`     | List posts with configurable sort order                      |
| `get_user_info`  | Retrieve public profile information for a Reddit user        |
| `approve`        | Approve a post or comment from the modqueue                  |
| `remove`         | Remove a post or comment (with optional spam flag)           |
| `ban_user`       | Ban a user from the subreddit                                |
| `send_modmail`   | Send a modmail message to a user                             |
| `flair_post`     | Apply a flair template to a post                             |

## Authentication

This model uses the Reddit OAuth2 "script app" flow. Credentials are passed as
global arguments when creating the model instance. Sensitive values (client
secret, password) should be stored in your swamp vault and referenced with
`vault://` URIs:

```bash
swamp vault set reddit/clientId "your-client-id"
swamp vault set reddit/clientSecret "your-client-secret"
swamp vault set reddit/username "your-bot-username"
swamp vault set reddit/password "your-bot-password"
```

The model obtains a short-lived bearer token at runtime by posting credentials
to `https://www.reddit.com/api/v1/access_token`. Tokens are not cached between
method invocations.

## Rate Limits

Reddit enforces a limit of **60 requests per minute** for OAuth-authenticated
apps. This model uses bounded pagination (maximum 10 pages per method call) to
avoid triggering rate limits on large subreddits. If results exceed the
pagination cap, the output `truncated` field is set to `true`.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md) for details.
