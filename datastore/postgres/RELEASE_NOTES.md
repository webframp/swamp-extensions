## 2026.11.10.1

**Changed:** Bump @opentelemetry/api 1.9.1 → 1.10.0

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

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
