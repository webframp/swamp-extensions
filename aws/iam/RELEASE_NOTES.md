## 2026.08.21.1

**Changed:** Per-profile scan failures in `discover_roles`, `discover_users`,
and `discover_policies` are now logged at `warn` level instead of `info` —
they were previously indistinguishable from routine progress messages, so a
credential failure or throttled account could silently disappear from the
scan with no visible signal. The log message now also names the discovery
operation (`discover_roles`/`discover_users`/`discover_policies`) alongside
the profile, and uses the underlying error's message rather than its full
string representation.

No schema changes.
