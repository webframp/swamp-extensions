## 2026.07.21.1

**Changed:** Authentication no longer shells out to `az` CLI. Auth now uses Azure AD client credentials flow (tenant_id + client_id + client_secret → access token). Resource discovery and metrics collection use the ARM REST API directly. This eliminates the `az` CLI runtime dependency.

**Added:** Three new required global arguments:
- `tenantId` (UUID) — Azure AD tenant ID
- `clientId` (UUID) — Azure AD application (client) ID
- `clientSecret` (sensitive) — Azure AD client secret

**Upgrade note:** This is a breaking change for existing model instances. You must add the three new global arguments:

```bash
swamp model create @webframp/azure/openai-usage azure-ai-usage \
  --global-arg 'subscriptions=["sub-id-1"]' \
  --global-arg 'tenantId=<your-tenant-id>' \
  --global-arg 'clientId=<your-app-id>' \
  --global-arg 'clientSecret=<vault:azure/sp-secret>'
```

The service principal needs Reader role on target subscriptions with `Microsoft.CognitiveServices/accounts/read` and `Microsoft.Insights/metrics/read` permissions.
