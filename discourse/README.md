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
| `get_topic`            | Full topic with all posts             | `topicId`                     |
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
```

## License

Apache-2.0
