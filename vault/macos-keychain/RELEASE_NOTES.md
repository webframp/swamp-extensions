## 2026.07.26.1

**Fixed:** Secrets with leading or trailing whitespace came back altered. The
`security` output was passed through `trim()`, which strips spaces and tabs at
both ends, not just the line terminator the CLI adds. Only a single trailing
newline is removed now, so `"  padded  "` round-trips intact.

**Fixed:** Keys are validated before the CLI runs. An empty key produced a
confusing `security` error, and a key starting with `-` was parsed by `security`
as a flag rather than an account name — `put("-U", secret)` did not do what it
looked like.

**Known limitation:** A secret whose own final character is a newline cannot be
distinguished from the terminator the CLI appends, so that byte is still lost.

**Still outstanding — the secret is passed as a command-line argument.**
`put` invokes `security add-generic-password … -w <secret>`, and process
arguments are readable by other processes running as the same user, including
any monitoring or endpoint agent that records command lines. `security` offers
no documented non-interactive way to supply a password other than argv; the
`-i` interactive mode reads commands from stdin but its quoting rules are
undocumented and cannot be exercised without a Mac. This is tracked separately
rather than being changed blind, because a wrong guess breaks the write path
for every user.
