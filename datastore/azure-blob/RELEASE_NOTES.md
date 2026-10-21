## 2026.10.21.1

**Fixed:** The README and the datastore's JSDoc example put the connection
string, account key and client secret into `.swamp.yaml` and `SWAMP_DATASTORE`
as literal values. Every example now stores the credential with
`swamp vault put` and references it with `"${{ vault.get(azure, <KEY>) }}"`,
which swamp resolves at startup.

**Changed:** `connectionString` is marked sensitive like `accountKey` and
`clientSecret`, and all three config fields describe the `vault.get` wiring.

**Upgrade note:** No behavioral or schema changes. If your `.swamp.yaml` holds a
literal credential, move it into a vault and replace it with a `vault.get`
expression.
