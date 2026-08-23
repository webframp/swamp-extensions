# @webframp/discourse

Query Discourse forums via the public REST API. List categories, browse topics,
read full posts, and search by keyword. Works with any Discourse instance.
Optional API key for private forums.

## Installation

```bash
swamp extension pull @webframp/discourse
```

## Setup

```bash
swamp model create @webframp/discourse my-forum
```

Edit the model definition:

```yaml
globalArguments:
  host: discourse.example.com
  # apiKey: ${{ vault.get("discourse", "API_KEY") }}  # optional for private forums
```

## Methods

| Method                 | Description                           | Inputs                        |
| ---------------------- | ------------------------------------- | ----------------------------- |
| `list_categories`      | List all categories with topic counts | —                             |
| `list_latest`          | Latest topics across all categories   | `page?`                       |
| `list_category_topics` | Topics in a specific category         | `slug`, `categoryId`, `page?` |
| `get_topic`            | Full topic with all posts (sets `truncated: true` if Discourse's API returned fewer posts than `postsCount`) | `topicId`                     |
| `search`               | Search topics by keyword              | `query`, `page?`              |

## Resources

| Resource        | Description                            | Lifetime        |
| --------------- | -------------------------------------- | --------------- |
| `categories`    | Category listing                       | 1h, 3 versions  |
| `topics`        | Topic listings (latest or by category) | 30m, 5 versions |
| `topicDetail`   | Full topic with posts                  | 1h, 5 versions  |
| `searchResults` | Search results                         | 30m, 5 versions |

## Examples

```bash
# List categories
swamp model method run my-forum list_categories

# Browse cyber news
swamp model method run my-forum list_category_topics --input slug=cyber-news --input categoryId=8

# Read a specific topic
swamp model method run my-forum get_topic --input topicId=170

# Search for CVEs
swamp model method run my-forum search --input query=CVE-2026

# Read a long topic — check topicDetail.truncated to see if posts were cut off
swamp data get my-forum topic-170 --json | jq '.truncated'
```

## Troubleshooting

- **`apiUsername is required when apiKey is set`** — `discourseFetch` throws
  this client-side before any request goes out if `globalArguments.apiKey`
  is set but `apiUsername` is not (`discourse.ts:134`). Set `apiUsername` to
  the Discourse username that owns the key; for a global admin key you can
  use `system`, but per-user keys must match the actual owner or Discourse
  will reject the request server-side instead.

- **`Discourse API 403 ...` or `404 ...` on categories/topics that "should"
  exist** — the wrapped error includes the HTTP status and the first 200
  characters of the response body (`discourse.ts:150-152`). A 403 on a
  category or topic that's visible in the browser usually means it's a
  private/restricted category and the request is unauthenticated — add
  `apiKey`/`apiUsername`. A 429 means the instance is rate-limiting your
  IP or key; back off and retry rather than looping.

- **`... returned an unexpected shape: expected a "category_list.categories"
  array ...`** (or the `topic_list.topics` / equivalent for `list_latest`
  and `list_category_topics`) — these methods hard-fail if the parsed JSON
  doesn't have the expected key (`discourse.ts:227-234`, `274-281`,
  `329-336`). This fires if `host` points at a non-Discourse site, a
  reverse proxy/login redirect that still returns HTTP 200, or a Discourse
  instance with a customized API response. Check `host` first, then hit
  the URL directly in a browser to confirm it's a real Discourse JSON
  endpoint.

- **`get_topic` returns `truncated: true`** — Discourse's `/t/:id.json`
  endpoint returns only an initial slice of `post_stream.posts` for topics
  with many replies; `topicDetail.truncated` is `posts.length <
  postsCount` (`discourse.ts:390`). The model does not currently paginate
  further posts, so a `true` value means the stored `posts` array is
  incomplete relative to `postsCount` — there's no method yet to fetch the
  remainder.

- **`search` pagination looks off by one compared to `list_latest`** —
  `search`'s `page` argument is 1-based (`default(1)`) because that's what
  Discourse's `/search.json` expects, while `list_latest` and
  `list_category_topics` are 0-based to match `/latest.json` and
  `/c/:slug/:id.json` (`discourse.ts:411` vs. `254`, `307`). Passing
  `page=0` to `search` will hit Discourse's first page, not an
  out-of-range one, so don't assume the same convention across methods.

## License

Apache-2.0
