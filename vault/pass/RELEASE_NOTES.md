## 2026.07.26.1

**Fixed:** Secrets with leading or trailing whitespace came back altered. The
CLI output was passed through `trim()`, which strips spaces and tabs at both
ends, not just the line terminator the CLI adds. Only a single trailing newline
is removed now, so `"  padded  "` round-trips intact.

**Fixed:** Keys were not validated, so `get("../../other/secret")` escaped the
configured `prefix` and read — or with `put`, overwrote — a secret outside the
namespace the config pinned the caller to. Keys containing `.` or `..` path
segments, absolute keys, empty keys, and keys starting with `-` (which `pass`
would parse as a flag) are now rejected before the CLI runs.

**Changed:** The `pass` subprocess no longer inherits the entire parent
environment. It previously received a copy of every variable in the calling
process, handing `pass` and every GPG agent hook it invokes any AWS key,
database URL, or API token that happened to be set. Only variables that `pass`
or GPG need are forwarded: `HOME`, `PATH`, `USER`, `LOGNAME`, `TMPDIR`, the
locale variables, `GNUPGHOME`, `GPG_AGENT_INFO`, `GPG_TTY`, `DISPLAY`,
`WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `SSH_AUTH_SOCK`, `TERM`, and the
`PASSWORD_STORE_*` settings.

**Upgrade note:** If your GPG setup depends on an environment variable outside
that list, `pass` operations will now fail where they previously worked. Open an
issue with the variable name and it will be added.

**Known limitation:** A secret whose own final character is a newline cannot be
distinguished from the terminator the CLI appends, so that byte is still lost.
This is inherent to reading secrets from a line-oriented CLI.
