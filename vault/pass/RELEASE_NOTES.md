## 2026.07.26.1

**Fixed:** Secrets with leading or trailing whitespace came back altered. The
CLI output was passed through `trim()`, which strips spaces and tabs at both
ends, not just the line terminator the CLI adds. Only a single trailing newline
is removed now, so `"  padded  "` round-trips intact.

**Fixed:** Keys were not validated, so `get("../../other/secret")` escaped the
configured `prefix` and read — or with `put`, overwrote — a secret outside the
namespace the config pinned the caller to. Keys containing `.` or `..` path
segments, empty path segments (`a//b`, `trailing/`), absolute keys, empty keys,
and keys starting with `-` (which `pass` would parse as a flag) are now rejected
before the CLI runs.

**Changed:** The `pass` subprocess no longer inherits the entire parent
environment. It previously received a copy of every variable in the calling
process, handing `pass` and every GPG agent hook it invokes any AWS key,
database URL, or API token that happened to be set. Only variables that `pass`
or GPG need are forwarded: `HOME`, `PATH`, `USER`, `LOGNAME`, `TMPDIR`, `SHELL`,
the locale variables, `GNUPGHOME`, `GPG_AGENT_INFO`, `GPG_TTY`, `SSH_AUTH_SOCK`,
`TERM`, the display and session variables pinentry needs (`DISPLAY`,
`WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`,
`PINENTRY_USER_DATA`, `XDG_*`), and the `PASSWORD_STORE_*` settings. The `find`
subprocess used by `list` is narrowed the same way.

**Added:** `extraEnv`, a list of additional environment variable names to
forward to the subprocess. Use it if an unusual GPG or pinentry setup needs a
variable outside the default set.

**Upgrade note:** If your GPG or pinentry setup depends on an environment
variable outside that list, `pass` operations will fail where they previously
worked. Add the variable name to `extraEnv` in your vault config to restore it,
and open an issue so it can be considered for the default list.

**Known limitation:** A secret whose own final character is a newline cannot be
distinguished from the terminator the CLI appends, so that byte is still lost.
This is inherent to reading secrets from a line-oriented CLI.
