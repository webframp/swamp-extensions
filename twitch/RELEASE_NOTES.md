## 2026.08.21.1

**Changed:** Tightened `channel`, `moderatorId`, `clientId`, `clientSecret`,
`accessToken`, and `refreshToken` on the global-args schema to require
non-empty strings. All six are required identifiers/tokens that the Twitch
API never accepts empty — this catches misconfigured vault references or
blank `--global-arg` values at model-create time instead of a confusing
Helix API failure on first method call.

## 2026.07.30.1

**Added:** `hasBroadcasterAuth` global arg (boolean, default `false`). When
false, `get_banned_users` and `get_mod_events` throw a clear error explaining
the broadcaster must have OAuth'd the app, instead of silently hitting a
Twitch 401.

**Changed:** Manifest description now separates methods into "Moderator auth"
and "Broadcaster auth" tables so users can see at a glance what works with
their token level. The OAuth scope URL replaces the deprecated `moderation:read`
with the granular `moderator:read:banned_users`.

**Changed:** Workflow step descriptions for `get-banned-users` and
`get-mod-events` note the broadcaster auth requirement. Both steps retain
`allowFailure: true` so the workflow completes even without broadcaster tokens.

**Upgrade note:** Existing model instances default to `hasBroadcasterAuth=false`
after upgrade. If you previously used `get_banned_users` or `get_mod_events`
successfully (because the broadcaster had authorized your app), update your
instances to restore that behavior:
`swamp model update <name> --global-arg hasBroadcasterAuth=true`
