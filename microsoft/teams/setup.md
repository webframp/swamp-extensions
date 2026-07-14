# @webframp/microsoft — Setup

This extension uses the existing `appsvc_teams_data_client` public client app
registration managed in `<your-group>/<your-project>/terraform/.../oidc_applications/`.

No client secret is required. Authentication uses device code flow with tokens
cached via the swamp vault.

## Prerequisites

The `appsvc_teams_data_client` app registration must grant these delegated scopes:

- `offline_access`
- `User.Read`
- `Team.ReadBasic.All`
- `Group.Read.All`
- `ChannelMessage.Read.All`
- `Chat.Read`

Access is restricted to members of `BETHEL-APP-AWS-CD-Everyone`.

## Vault Configuration

Store these values in your swamp vault:

| Key            | Value                                       |
|----------------|---------------------------------------------|
| `tenantId`     | Azure AD tenant GUID                        |
| `clientId`     | App registration client ID                  |
| `refreshToken` | Obtained via `bootstrap` method (see below) |

## Initial Authentication

1. Create a model instance with `tenantId` and `clientId` from the vault.
   Set `refreshToken` to any placeholder (it will be replaced by bootstrap).

2. Run the `bootstrap` method:
   ```
   swamp model method run <name> bootstrap
   ```

3. The method outputs a device code and verification URL. Open the URL in a
   browser, enter the code, and complete sign-in.

4. On success, the method writes the new `refreshToken` to its output data.
   Copy that value into your vault.

5. Subsequent method calls use the vault's refresh token for silent auth.
   Tokens auto-rotate on each use (Graph returns a new refresh token with
   each access token request).

## Token Expiry

Refresh tokens expire after 90 days of inactivity. If any method returns an
`invalid_grant` error, re-run `bootstrap` to re-authenticate.
