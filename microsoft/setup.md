# @webframp/microsoft — Azure app registration setup

This document covers the exact `az` CLI commands to create and configure the Azure
app registration required by this extension. All settings follow least-privilege
principles: single-tenant, confidential client, delegated-only permissions scoped
to the signed-in user's own data.

## Prerequisites

```bash
az login
az account set --subscription "<your-subscription-id>"
```

Verify you are in the right tenant:

```bash
az account show --query "{tenant: tenantId, user: user.name}" -o table
```

---

## 1. Create the app registration

```bash
APP_NAME="swamp-microsoft-extension"

az ad app create \
  --display-name "$APP_NAME" \
  --sign-in-audience AzureADMyOrg
```

`AzureADMyOrg` locks the registration to your single tenant. Capture the returned
`appId` (client ID) and `id` (object ID — needed for later commands):

```bash
APP_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)
APP_OID=$(az ad app list --display-name "$APP_NAME" --query "[0].id" -o tsv)

echo "appId (clientId for vault): $APP_ID"
echo "objectId:                   $APP_OID"
```

---

## 2. Create a service principal

Required so the app can be assigned permissions and a client secret:

```bash
az ad sp create --id "$APP_ID"
```

---

## 3. Add the native client redirect URI

This is the Microsoft-controlled loopback URI for device code / native client flows.
It does not accept inbound HTTP traffic and has no exfiltration surface.

```bash
az ad app update \
  --id "$APP_OID" \
  --public-client-redirect-uris "https://login.microsoftonline.com/common/oauth2/nativeclient"
```

---

## 4. Disable public client flows

Ensures a client secret is always required — no unauthenticated device code
initiation with a bare `clientId`:

```bash
az ad app update \
  --id "$APP_OID" \
  --set isFallbackPublicClient=false
```

---

## 5. Grant delegated API permissions

Microsoft Graph app ID is the stable well-known value `00000003-0000-0000-c000-000000000000`.
The five permission GUIDs below are Microsoft-published stable values for the delegated
scopes this extension requires.

```bash
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"

# offline_access  — required for refresh tokens
OFFLINE_ACCESS="7427e0e9-2fba-42fe-b0c0-848c9e6a8182"
# User.Read       — signed-in user's own profile
USER_READ="e1fe6dd8-ba31-4d61-89e7-88639da4683d"
# Mail.ReadWrite  — signed-in user's own mailbox
MAIL_READWRITE="024d486e-b451-40bb-833d-3e66d98c5c73"
# MailboxSettings.Read — signed-in user's own mailbox settings
MAILBOX_SETTINGS_READ="87f447af-9fa4-4c32-9dfa-4a57a73d18ce"
# Chat.Read       — signed-in user's own Teams chats
CHAT_READ="f501c180-9344-439a-bca0-6cbf209fd270"

az ad app permission add \
  --id "$APP_OID" \
  --api "$GRAPH_APP_ID" \
  --api-permissions \
    "${OFFLINE_ACCESS}=Scope" \
    "${USER_READ}=Scope" \
    "${MAIL_READWRITE}=Scope" \
    "${MAILBOX_SETTINGS_READ}=Scope" \
    "${CHAT_READ}=Scope"
```

These are all **delegated** (`=Scope`) permissions that operate on the signed-in
user's own data only. None require admin consent.

Grant user consent on behalf of yourself (avoids the interactive consent prompt
on first device code login). Replace `<your-user-object-id>` with the output of
`az ad signed-in-user show --query id -o tsv`:

```bash
USER_OID=$(az ad signed-in-user show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)

az ad app permission grant \
  --id "$APP_OID" \
  --api "$GRAPH_APP_ID" \
  --scope "offline_access User.Read Mail.ReadWrite MailboxSettings.Read Chat.Read"
```

---

## 6. Create a client secret

Use the shortest expiry that is operationally comfortable. Six months forces regular
rotation without excessive toil:

```bash
SECRET_JSON=$(az ad app credential reset \
  --id "$APP_OID" \
  --years 0.5 \
  --display-name "swamp-vault-$(date +%Y-%m-%d)" \
  --append \
  --output json)

CLIENT_SECRET=$(echo "$SECRET_JSON" | jq -r '.password')
echo "clientSecret (store in vault — shown once): $CLIENT_SECRET"
```

> **Note:** `--years 0.5` sets a 6-month expiry. The Azure portal shows this as
> ~180 days. If the CLI on your system rejects fractional years, use `--end-date`
> with an explicit date: `--end-date $(date -d '+180 days' +%Y-%m-%d)` (Linux) or
> `--end-date $(date -v+180d +%Y-%m-%d)` (macOS).

---

## 7. Collect vault values

```bash
TENANT_ID=$(az account show --query tenantId -o tsv)

echo "tenantId:     $TENANT_ID"
echo "clientId:     $APP_ID"
echo "clientSecret: $CLIENT_SECRET   # from step 6 — not re-displayable"
echo "refreshToken: (run bootstrap method to obtain)"
```

Store these in your swamp vault. The `refreshToken` does not exist yet — run the
`bootstrap` method on the outlook model to complete device code authentication and
capture it.

---

## 8. Verify the registration

```bash
az ad app show --id "$APP_OID" \
  --query "{displayName: displayName, appId: appId, signInAudience: signInAudience, \
            isFallbackPublicClient: isFallbackPublicClient}" \
  -o table

az ad app permission list --id "$APP_OID" -o table
```

Expected output for permissions — five rows, all `Scope` type, all against
`00000003-0000-0000-c000-000000000000`:

| resourceAppId | resourceAccess.id | resourceAccess.type |
|---|---|---|
| 00000003-... | 7427e0e9-... (offline_access) | Scope |
| 00000003-... | e1fe6dd8-... (User.Read) | Scope |
| 00000003-... | 024d486e-... (Mail.ReadWrite) | Scope |
| 00000003-... | 87f447af-... (MailboxSettings.Read) | Scope |
| 00000003-... | f501c180-... (Chat.Read) | Scope |

---

## What is deliberately excluded

| Scope | Reason excluded |
|---|---|
| `Mail.Send` | Extension never sends mail; granting it means a leaked secret could send mail as you |
| `Team.ReadBasic.All` | "All" reads every team in the tenant, not just yours |
| `Channel.ReadBasic.All` | Same tenant-wide read concern |
| `ChannelMessage.Read.All` | Tenant-wide + requires admin consent |
| Any `Application`-type permission | Application permissions are not bound to a user; they grant access to all users' data in the tenant |

If you later need channel message access, add `Channel.ReadBasic.All` and
`ChannelMessage.Read.All` as `=Scope` permissions and re-run `az ad app permission grant`.
Your tenant admin will need to grant admin consent for `ChannelMessage.Read.All`.

---

## Secret rotation

When the client secret approaches expiry:

```bash
# Add a new secret before removing the old one (zero-downtime rotation)
NEW_SECRET_JSON=$(az ad app credential reset \
  --id "$APP_OID" \
  --years 0.5 \
  --display-name "swamp-vault-$(date +%Y-%m-%d)" \
  --append \
  --output json)

NEW_SECRET=$(echo "$NEW_SECRET_JSON" | jq -r '.password')
echo "New secret: $NEW_SECRET"

# Update your vault, then remove the old credential by its keyId:
az ad app credential list --id "$APP_OID" -o table
# az ad app credential delete --id "$APP_OID" --key-id "<old-key-id>"
```
