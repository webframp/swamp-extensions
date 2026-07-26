## 2026.07.26.1

**Fixed:** Secrets with leading or trailing whitespace came back altered. The
CLI output was passed through `trim()`, which strips spaces and tabs at both
ends, not just the line terminator the CLI adds. Only a single trailing newline
is removed now, so `"  padded  "` round-trips intact.

**Fixed:** Keys were not validated, so `get("../../other/secret")` escaped the
configured `store` and read — or with `put`, overwrote — a secret outside the
namespace the config pinned the caller to. Keys containing `.` or `..` path
segments, empty path segments (`a//b`, `trailing/`), absolute keys, empty keys,
and keys starting with `-` (which `gopass` would parse as a flag) are now
rejected before the CLI runs.

**Note:** Unlike `@webframp/pass` at this version, the `gopass` subprocess still
inherits the full parent environment. gopass has a much larger set of its own
`GOPASS_*` and backend variables, and narrowing it needs to be validated against
a live gopass store before it ships.

**Known limitation:** A secret whose own final character is a newline cannot be
distinguished from the terminator the CLI appends, so that byte is still lost.
This is inherent to reading secrets from a line-oriented CLI.
