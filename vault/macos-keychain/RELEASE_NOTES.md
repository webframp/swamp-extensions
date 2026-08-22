## 2026.08.21.1

**Changed:** When the `security` CLI exits non-zero, the thrown error now
names the subcommand that failed (e.g. `security find-generic-password -s
swamp -a my-key -w exited with code 44: ...`) instead of just the exit code
and bare stderr. For the interactive `put` path (`security -i`), the error
now includes the redacted command line that was sent on stdin, since argv
alone (`-i`) never said what operation was attempted. Secret values and
their hex encoding are still stripped before the error is constructed, as
before — this only adds which operation and key were involved.
