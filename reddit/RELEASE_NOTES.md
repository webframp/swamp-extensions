## 2026.10.21.1

**Fixed:** The README and the registry Quick Start showed `vault://reddit/...`
global arguments and a `vault set` subcommand. Neither is swamp syntax: swamp
has no `vault set`, and it does not resolve `vault://` strings. Because
`clientSecret` and `password` are marked sensitive, swamp refuses a literal
value for them, so `swamp model create` rejected the documented command
outright; `clientId` and `username` would have been passed through as the
literal `vault://` text. The docs now store the client secret and password with
`swamp vault put reddit <KEY>` (interactive prompt) and wire them with
`${{ vault.get("reddit", "...") }}`.

**Changed:** Documentation only otherwise: the `clientSecret` and `password`
global argument descriptions now say to supply the value through `vault.get`.

**Upgrade note:** No code, schema, or behavioral changes. The model version
moves to 2026.10.21.1 with an identity upgrade. The old example could not create
an instance, so existing instances need no change.
