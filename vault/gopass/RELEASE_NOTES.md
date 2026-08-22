## 2026.08.21.1

**Changed:** When the `gopass` CLI exits non-zero, the thrown error now
names the subcommand that failed (e.g. `gopass show -o -n <path> exited
with code 1: entry not found`) instead of just the exit code and bare
stderr. Previously a failure surfaced only gopass's own message with no
indication of which operation — `show`, `insert`, or `list` — was in
progress; that's important context to have when multiple vault calls happen
back to back. Secret values passed on stdin are still redacted before the
error is constructed, as before.
