## 2026.08.21.1

**Fixed:** `list()` no longer reports a missing or unreadable password store
directory as an empty listing. Previously, if the underlying `find`
subprocess failed for any reason — a bad `storeDir`, permissions, `find` not
being installed — the provider silently returned `[]`, indistinguishable
from a store that legitimately has no secrets yet. It now throws an error
naming the directory and the `find` exit code/stderr.

**Changed:** When the `pass` CLI exits non-zero, the thrown error now names
the subcommand that failed (e.g. `pass show swamp/my-key exited with code
1: Error: swamp/my-key is not in the password store.`) instead of just the
exit code and bare stderr. Secret values passed on stdin to `insert` are
still redacted before the error is constructed, as before.
