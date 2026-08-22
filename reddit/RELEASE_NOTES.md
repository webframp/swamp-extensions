## 2026.08.21.2

**Changed:**

- Reddit API errors (auth, GET, POST) now name the request path (and, for
  the OAuth2 token request, the account username) instead of only the HTTP
  status code and response body — e.g. "Reddit API GET /r/foo/about/modqueue
  failed (500): ..." instead of "Reddit API error (500): ...".
- Moderation action failures (`approve`, `remove`, `ban_user`,
  `send_modmail`, `flair_post`) now include the target item id, username, or
  subreddit in the thrown error, instead of only the raw Reddit error
  payload — so a failed action is traceable back to what it was acting on.
- A network-level failure (DNS, connection refused, TLS) talking to Reddit
  now surfaces which request it was attempting instead of a bare, unlabeled
  fetch exception.
