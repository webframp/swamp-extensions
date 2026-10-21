## 2026.10.21.1

**Fixed:** The manifest wired `clientSecret` as `<vault:azure/sp-secret>`, which
swamp does not resolve, and the README showed a literal
`clientSecret=<secret-value>`. Both now store the secret with
`swamp vault put azure CLIENT_SECRET` and wire it with
`${{ vault.get("azure", "CLIENT_SECRET") }}`. The README states the vault is
required, not merely recommended.

**Changed:** The `clientSecret` argument description says to supply it with a
`vault.get` expression.

**Changed:** The manifest Quick Start creates the vault first with
`swamp vault create local_encryption <name>` (a once-only step for a repo with
no vault yet), so it works in a fresh repo.

**Upgrade note:** Documentation only; no behavioral or schema changes.
