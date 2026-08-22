## 2026.08.21.1

**Added:**

- `dns_records`, `whois_info`, and `traceroute` resources now include an
  `error` field (nullable, `null` on success). When `dig`, `whois`, or
  `traceroute` exits non-zero, this field carries the command's stderr so a
  failed lookup is distinguishable from a domain/host with genuinely no
  data, instead of silently returning empty records.

**Changed:**

- `dns_lookup`, `http_check`, `whois_lookup`, `cert_check`, `traceroute`, and
  `port_check` now reject an empty `domain`/`url`/`host` argument with a
  clear validation error before invoking the underlying command, instead of
  running `dig`/`whois`/`openssl`/`traceroute` against an empty target and
  surfacing whatever cryptic error the tool produces.
- `port_check`'s `ports` argument now requires at least one port and rejects
  port numbers outside 1-65535, instead of silently scanning zero ports or
  passing an invalid port straight to `Deno.connect`.
- If the underlying command binary itself is missing or fails to spawn
  (`dig`, `whois`, `traceroute`, `openssl` via `bash`), the error now names
  the command and target instead of surfacing an unqualified low-level
  "No such file or directory" exception.

**Upgrade note:** No global-arg or method-signature changes. Existing stored
`dns_records`, `whois_info`, and `traceroute` resources remain valid — the
new `error` field is nullable and defaults to `null` on read.
