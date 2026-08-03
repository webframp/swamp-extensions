## 2026.08.03.1

**Fixed:** GitLab API calls that hit a `429 Too Many Requests` response failed
immediately instead of retrying, which reliably interrupted `swamp datastore
setup` migrations that push hundreds of state objects in quick succession. All
GitLab API calls now retry a 429 up to 5 times before giving up: the client
honors a `Retry-After` header when GitLab sends one, and otherwise backs off
exponentially (1s, 2s, 4s, ...), with jitter either way so many concurrent
callers don't retry in lockstep. Only after exhausting retries does the call
fail with the same error message as before.

**Changed:** Lock acquisition (`GitLabLock.acquire()`) bounds every retry —
including 429 backoff — to what's left of its own `maxWaitMs`, so a lock call
gives up on schedule even while GitLab is actively rate-limiting it, instead
of a single retrying call silently running past the caller's declared
timeout. `deleteState` calls made during push (tombstoning) now honor the
sync operation's cancellation signal the same way `getState`/`putState`
already did. Lock release, force-release, inspection, and the health-check
verifier are not bounded this way — they have no existing timeout contract to
preserve, so a sustained 429 there can still take up to the full retry
backoff (worst case, a large `Retry-After` × 5 attempts) before failing.

**Upgrade note:** No action required. Retries are internal to the GitLab API
client and transparent to almost every caller — no config or call-site
changes.
