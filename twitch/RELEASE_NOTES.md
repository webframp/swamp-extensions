## 2026.10.21.1

**Fixed:** The registry Quick Start created model instances without
`clientId`, `clientSecret`, `accessToken`, or `refreshToken`, which are required,
so the documented command failed. It also used `swamp vault set`, which does
not exist. Both Quick Starts now wire every credential with
`${{ vault.get("twitch", "...") }}`.

**Changed:** Documentation only otherwise. Credentials are stored with
`swamp vault put twitch <KEY>` at the interactive prompt instead of with the
value on the command line. The OAuth token exchange now sends the client secret
to `curl` on stdin rather than in argv, and stores the returned tokens straight
into the vault without printing them. The examples use a vault named `twitch`
with `CLIENT_ID`, `CLIENT_SECRET`, `ACCESS_TOKEN`, and `REFRESH_TOKEN` keys;
existing instances that reference other vault or key names keep working. The
credential global argument descriptions now say to supply them through
`vault.get`.

**Upgrade note:** No code, schema, or behavioral changes. The model version
moves to 2026.10.21.1 with an identity upgrade.
