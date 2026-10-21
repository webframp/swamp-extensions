# @webframp/microsoft — Setup

This extension uses the existing `appsvc_teams_data_client` public client app
registration managed in
`<your-group>/<your-project>/terraform/.../oidc_applications/`.

No client secret is required. Authentication uses device code flow with tokens
stored in a swamp vault.

## Prerequisites

The `appsvc_teams_data_client` app registration must grant these delegated
scopes:

- `offline_access`
- `User.Read`
- `Team.ReadBasic.All`
- `Group.Read.All`
- `ChannelMessage.Read.All`
- `Chat.Read`

Access is restricted to members of `BETHEL-APP-AWS-CD-Everyone`.

## Vault Configuration

Store the tenant and client IDs in a swamp vault (each command prompts for the
value):

```bash
swamp vault create local_encryption microsoft   # once, if you have no vault yet
swamp vault put microsoft TENANT_ID             # Azure AD tenant GUID
swamp vault put microsoft CLIENT_ID             # App registration client ID
```

The refresh token is never entered by hand. `bootstrap` obtains it and swamp
stores it in the repo's default vault under the key `TEAMS_REFRESH_TOKEN`.

## Initial Authentication

1. Create a model instance that reads `tenantId` and `clientId` from the vault.
   Leave `refreshToken` unset:
   ```bash
   swamp model create @webframp/microsoft/teams <name> \
     --global-arg 'tenantId=${{ vault.get("microsoft", "TENANT_ID") }}' \
     --global-arg 'clientId=${{ vault.get("microsoft", "CLIENT_ID") }}'
   ```

2. Run the `bootstrap` method:
   ```bash
   swamp model method run <name> bootstrap
   ```

3. The method outputs a device code and verification URL. Open the URL in a
   browser, enter the code, and complete sign-in.

4. On success, swamp stores the refresh token in the default vault and the
   bootstrap data records only its `vault.get` reference. Show it with
   `swamp data query 'behavior("<name>") && name == "main"' --select content`.

5. Run `swamp model edit <name>` and set the `refreshToken` global argument to
   that reference, e.g.
   `refreshToken: ${{ vault.get("default", "TEAMS_REFRESH_TOKEN") }}`.

6. Subsequent method calls exchange the vault's refresh token for an access
   token silently. The stored token is not rotated: Graph returns a new refresh
   token with each exchange, but the model discards it and keeps using the one
   `bootstrap` stored. When that token is revoked or expires, methods fail with
   `invalid_grant`; re-run `bootstrap` to store a fresh one.

## Token Expiry

Refresh tokens expire after 90 days of inactivity. If any method returns an
`invalid_grant` error, re-run `bootstrap` to re-authenticate.
