## 2026.08.21.2

**Changed:** Errors from shell commands now say what went wrong and which
command was involved. Previously, if a command binary couldn't be spawned at
all (not installed, not on `PATH`, not executable), the raw OS error
propagated with no indication of which command swamp was trying to run; now
the error names the full command line alongside the OS error. A non-zero
exit now reports the exit code in addition to stderr. `get_network_interfaces`
now reports which command produced unparseable output if `ip -j addr show`
returns something that isn't valid JSON, instead of a bare `SyntaxError`.
`get_os_info` now logs a reason when `/etc/os-release` can't be read, instead
of silently continuing with an empty `osRelease` and no record of why.

## 2026.08.21.1

**Changed:** Tightened `get_processes`'s `count` argument to require a
positive integer. The method already used it as a slice length starting
from the top of the sorted process list, so a zero, negative, or fractional
value never produced anything meaningful — this catches that at validation
time instead of silently returning zero or misshapen results.

## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `diagnostics.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.
