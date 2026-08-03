## 2026.08.03.1

**Fixed:** GitLab API calls that hit a `429 Too Many Requests` response failed
immediately instead of retrying, which reliably interrupted `swamp datastore
setup` migrations that push hundreds of state objects in quick succession. All
GitLab API calls now retry a 429 up to 5 times before giving up: the client
honors a `Retry-After` header when GitLab sends one, and otherwise backs off
exponentially (1s, 2s, 4s, ...), with jitter either way so many concurrent
callers don't retry in lockstep. Only after exhausting retries does the call
fail with the same error message as before.

**Upgrade note:** No action required. Retries are internal to the GitLab API
client and transparent to every caller (lock, sync, verifier) — no config or
call-site changes.
