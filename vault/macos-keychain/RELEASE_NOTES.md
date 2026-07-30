## 2026.07.30.1

Closes the two problems tracked in #275. Every behavior below was probed on
real hardware (macOS 26.5.2, build 25F84) before implementation; the probe
record is in the issue.

**Fixed:** `put` no longer passes the secret as a command-line argument.
Process arguments are readable by any process running as the same user, so
every secret written through this vault was visible to `ps`, EDR agents, and
anything else that records command lines. The secret is now hex-encoded and
fed to `security -i` on stdin as `add-generic-password ... -X <hex>`. Hex
survives the interactive parser's tokenizer unchanged, so values with spaces,
quotes, backslashes, newlines, and non-ASCII bytes all store byte-exact.

**Fixed:** `get` no longer returns garbage for secrets containing
non-printable or non-ASCII bytes on macOS 26. There,
`find-generic-password -w` prints lowercase hex instead of the secret when any
byte falls outside printable ASCII (0x20–0x7E). Output that looks like hex is
now disambiguated through `-g`, whose output marks the encoding explicitly
(`password: 0x...` versus `password: "..."`), and decoded only when the
keychain says it is hex. A secret whose value legitimately looks like hex
(for example the literal string `deadbeef`) is returned verbatim — never
decoded. Older macOS versions are unaffected: raw output of a secret with a
non-printable byte can never look like hex, so the check does not engage.

**Changed:** the maximum secret size for `put` drops from roughly 1 MiB (the
argv limit) to about 2 KB (the `security -i` 4096-byte line buffer, minus
command overhead; the exact figure depends on the service and key length).
Oversize writes now fail with a descriptive error **before** anything is
executed. This is deliberate: the interactive parser splits over-long lines
and can store a silently corrupted value, which is worse for a vault than a
loud refusal. Reads are unaffected — existing larger secrets still round-trip
(verified to 4 KiB).

**Changed:** `get` now fails loudly instead of guessing in two cases: when the
keychain reports a hex-encoded value that is not valid UTF-8 (this provider
returns strings, and replacement characters would be silent corruption), and
when the encoding of an ambiguous read cannot be determined. A vault that
returns a wrong secret is worse than one that errors.

**Changed:** keys and the configured service name now reject control
characters (previously only NUL was rejected in keys). A newline would split
the command line `put` writes to `security -i`.

**Changed:** on macOS 26, a secret ending in a newline now round-trips
exactly. Such values take the hex path, which is byte-exact, so the
long-documented trailing-newline ambiguity only remains for raw reads on
older macOS versions.

**Upgrade note:** no schema or config changes. If you store secrets larger
than ~2 KB through this vault, `put` will now refuse them — store large blobs
elsewhere and keep the keychain for credentials.
