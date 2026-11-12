## 2026.11.12.1

**Fixed:** A dropped or black-holed connection could stall a push for ~15
minutes (the Linux TCP retransmission timeout) and then fail with
`fetch failed`. Blob requests and the Azure AD token exchange had no deadline.
They now do, covering the response body read, and a stalled request fails with
a `TimeoutError`. Reported by @NeilHanlon in #561.

**Changed:** Deadlines scale with payload so large blobs are not cut off. Each
request gets a 120 s base, plus 1 s per 512 KiB (~4 Mbit/s) of request body for
uploads, or of `Content-Length` for the response body on downloads. A transfer
slower than ~4 Mbit/s on a large blob can still hit the deadline, and
parallel uploads (up to 12) share one link, so each sees less than the
allowance assumes. A response with no `Content-Length` gets only the base. The base is
not yet configurable from the datastore config.

**Changed:** Data-plane requests (blob, shard, `commit_seq`, and watermark
reads and writes) that hit the deadline are retried up to 3 attempts with
backoff before the `TimeoutError` is rethrown, so a worst-case stalled push
takes minutes rather than ~15. A retried upload re-sends its whole body.

**Changed:** Lock requests use a 20 s deadline (also for the Azure AD token exchange they
trigger) and are never retried on
timeout, because repeating a lease acquire whose response was lost would leave
an orphaned lease. A lock request that times out reports the blob operation
and path. The lock heartbeat itself is unchanged: it still renews every
`lease/3` for as long as the holder process is alive. A background renewal that
times out is swallowed and the lease expires on its own, as with any other
renewal failure; a direct `heartbeat()` call rejects with an error whose `cause` is the
`TimeoutError`.
