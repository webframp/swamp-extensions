## 2026.10.21.1

**Fixed:** The README configuration example put a literal personal access token
into `.swamp.yaml`. It now stores the token with `swamp vault put gitlab TOKEN`
and references it with `"${{ vault.get(gitlab, TOKEN) }}"`, and shows the same
expression inside `SWAMP_DATASTORE`.

**Changed:** The `token` config field is marked sensitive and its description
says to supply it with a `vault.get` expression.

**Upgrade note:** No behavioral or schema changes. If your `.swamp.yaml` holds a
literal token, move it into a vault and replace it with a `vault.get`
expression.
