## 2026.10.21.1

**Fixed:** The README and the datastore's JSDoc example put a connection string
with an embedded password into `.swamp.yaml` and `SWAMP_DATASTORE`. They now
store it with `swamp vault put postgres CONNECTION_STRING` and reference it with
`"${{ vault.get(postgres, CONNECTION_STRING) }}"`.

**Changed:** The `connectionString` config field is marked sensitive and its
description says to supply it with a `vault.get` expression. The integration
test example notes that its URL must point at a throwaway local database.

**Upgrade note:** No behavioral or schema changes. If your `.swamp.yaml` holds a
literal connection string, move it into a vault and replace it with a
`vault.get` expression.
