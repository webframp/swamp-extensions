## 2026.11.10.3

**Fixed:** Every lock path worked exactly once, then failed permanently with
`Failed to create lock blob ... (409): BlobAlreadyExists`. `release()` frees the
lease but leaves the lock blob, and Azure answers the next create-if-absent
(`If-None-Match: *`) with 409 `BlobAlreadyExists`, which the lock code only
accepted as 412. It now treats 409 `BlobAlreadyExists` as the normal
"blob already exists" case and proceeds to acquire the lease. Other 409
responses (for example `ContainerBeingDeleted`) still fail. Reported by
@NeilHanlon in #556.

**Fixed:** The same misclassification affected the shard index and
`commit_seq` writes. When two writers raced to create the first shard or
`commit_seq` blob, the loser got 409 `BlobAlreadyExists` and the push threw
instead of re-reading and retrying. Both now retry on it like an ETag conflict.

**Changed:** `release()` and `forceRelease()` now delete the lock blob in the
same request that releases the lease (Delete Blob with the lease ID), so
`_locks/` no longer accumulates one orphan per lock key and there is no moment
where the lease is free but the blob still exists. If that delete is refused
(for example a SAS token without delete permission, or a lease that is no
longer yours), they fall back to a plain lease release, which leaves the blob
as before. A waiter whose lock blob is deleted between its existence check and
its lease request re-creates it and retries, up to 5 consecutive times; any
lease conflict resets that count, so waiting out a long queue is unaffected.

**Upgrade note:** Datastores already wedged by this bug recover on upgrade; no
manual deletion of lock blobs is needed.

## 2026.11.10.2

**Fixed:** Data names containing `/` or a space (stored by swamp on disk as
`%002F` and `%0020`) failed to push, pull, or migrate with HTTP 400 "Invalid
URL." because the on-disk path went into the blob URL unencoded, and the URL
parser read `%00` as a NUL byte. Blob names are now percent-encoded before the
request, matching how the lock blob key is already handled. Reported by
@NeilHanlon in #554.

**Changed:** Blob names preserve `/`, `@ : . - _ ~` and the RFC 3986 sub-delims
(`+ ( ) , ; = ! $ & ' * [ ]`), so existing blobs keep their names. Everything
else, including `%`, `?`, `#`, space, and non-ASCII characters, is
percent-encoded in the request path (and in the Shared Key signature, so names
with spaces or non-ASCII characters now sign correctly).

**Upgrade note:** A name containing a valid percent escape other than `%00`
(for example a literal `%41`) was previously decoded by Azure on upload and
is now stored under its literal name. swamp's own escapes (`%002F`, `%0020`)
always failed before this fix, so no existing blob is affected by them.

## 2026.11.10.1

**Changed:** Bump @opentelemetry/api 1.9.1 → 1.10.0

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Fixed:** The README and the datastore's JSDoc example put the connection
string, account key and client secret into `.swamp.yaml` and `SWAMP_DATASTORE`
as literal values. Every example now stores the credential with
`swamp vault put` and references it with `"${{ vault.get(azure, <KEY>) }}"`,
which swamp resolves at startup.

**Changed:** `connectionString` is marked sensitive like `accountKey` and
`clientSecret`, and all three config fields describe the `vault.get` wiring.

**Upgrade note:** No behavioral or schema changes. If your `.swamp.yaml` holds a
literal credential, move it into a vault and replace it with a `vault.get`
expression.
