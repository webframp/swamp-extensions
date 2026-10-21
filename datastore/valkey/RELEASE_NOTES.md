## 2026.10.21.1

**Changed:** The `password` config field is marked sensitive, and its
description now says to always supply it with
`"${{ vault.get(valkey, PASSWORD) }}"` instead of "prefer a vault expression for
production use". The `url` description says not to embed a password.

**Added:** A README "Authentication" section that stores the password with
`swamp vault put valkey PASSWORD` and wires it with `vault.get`, including the
ElastiCache/MemoryDB TLS example, the `SWAMP_DATASTORE` form, and the JSDoc
example.

**Upgrade note:** No behavioral or schema changes. If your `.swamp.yaml` holds a
literal password, move it into a vault and replace it with a `vault.get`
expression.
