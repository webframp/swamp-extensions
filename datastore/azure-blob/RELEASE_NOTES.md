## 2026.11.10.2

**Fixed:** Data names containing `/` or a space (stored by swamp on disk as
`%002F` and `%0020`) failed to push, pull, or migrate with HTTP 400 "Invalid
URL." because the on-disk path went into the blob URL unencoded, and the URL
parser read `%00` as a NUL byte. Blob names are now percent-encoded before the
request, matching how the lock blob key is already handled. Reported by
@NeilHanlon in #554.

**Changed:** Blob names preserve `/`, `@ : . - _ ~` and the RFC 3986 sub-delims
(`+ ( ) , ; = ! $ & ' * [ ]`), so existing blobs keep their names and no data
migration is needed. Only `%`, `?`, `#`, and characters outside that set are
now encoded.

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
