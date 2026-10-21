## 2026.10.21.1

**Changed:** `bootstrap` no longer tells you to copy the refresh token into a
vault by hand. Swamp now stores the token in the repo's default vault under the
fixed key `TEAMS_REFRESH_TOKEN` (previously a generated, per-model key that the
docs never mentioned), and the bootstrap data holds only a
`${{ vault.get('<vault>', 'TEAMS_REFRESH_TOKEN') }}` reference. Running
`bootstrap` requires a vault to exist (repos created with `swamp repo init` have
one named `default`).

**Changed:** The `refreshToken` global argument is now optional, so a model can
be created before `bootstrap` has run. Every method other than `bootstrap` fails
with a `missing_refresh_token` error until it is set. A literal placeholder
token is no longer needed (or accepted by swamp for a sensitive argument).

**Changed:** README and setup guide store `tenantId` and `clientId` with
`swamp vault put` and wire all three global arguments with `vault.get`
expressions.

**Fixed:** The README and setup guide claimed refresh tokens auto-rotate on each
use. The model keeps using the token `bootstrap` stored and does not save the
rotated token Graph returns; the docs now say so and tell you to re-run
`bootstrap` on `invalid_grant`. Documentation only; token handling is unchanged.

**Upgrade note:** Existing models keep working unchanged. To move to the
vault-managed token, re-run `bootstrap`, then set `refreshToken` with
`swamp model edit` to the reference shown in the bootstrap data (for example
`${{ vault.get("default", "TEAMS_REFRESH_TOKEN") }}` when your default vault is
named `default`). Older bootstrap data versions may still contain a plaintext
token; delete them if they must not be retained.
