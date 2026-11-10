## 2026.11.10.3

**Fixed:** Every lock path worked exactly once, then failed permanently with
`Failed to create lock blob ... (409): BlobAlreadyExists`. `release()` frees the
lease but leaves the lock blob, and Azure answers the next create-if-absent
(`If-None-Match: *`) with 409 `BlobAlreadyExists`, which the lock code only
accepted as 412. It now treats 409 `BlobAlreadyExists` as the normal
"blob already exists" case and proceeds to acquire the lease. Other 409
responses (for example `ContainerBeingDeleted`) still fail. Reported by
@NeilHanlon in #556.

**Changed:** Lock blobs are still not deleted on release. Deleting after release
would race a waiter that already passed the existence check and is about to
acquire its lease, so orphaned `_locks/` blobs remain by design (they are empty
and their lease state is `available`).

**Upgrade note:** Datastores already wedged by this bug recover on upgrade; no
manual deletion of lock blobs is needed.
