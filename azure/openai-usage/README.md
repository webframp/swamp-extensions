# @webframp/azure/openai-usage

Azure OpenAI / AI Services token usage monitoring — multi-subscription scanning
of ProcessedPromptTokens and GeneratedTokens via Azure Monitor. Auto-discovers
CognitiveServices resources and provides per-deployment breakdowns.

## Authentication

Uses Azure AD client credentials flow (tenant ID + app registration client ID +
client secret). No `az` CLI dependency.

All three credentials are required global arguments:

- `tenantId` — Azure AD tenant UUID
- `clientId` — App registration (service principal) UUID
- `clientSecret` — Client secret value (stored in swamp vault recommended)

## Required Permissions

Assign the following to the app registration's service principal on each target
subscription:

- **Role:** Reader (built-in) on the subscription
- **Permissions granted by Reader:**
  - `Microsoft.CognitiveServices/accounts/read` (resource discovery)
  - `Microsoft.Insights/metrics/read` (token usage metrics)

Reader is the least-privilege built-in role that covers both. Do not grant
Contributor or Owner.

## Usage

```bash
swamp model create @webframp/azure/openai-usage azure-ai-usage \
  --global-arg 'subscriptions=["cef96095-...","690e5f6d-..."]' \
  --global-arg 'tenantId=<tenant-uuid>' \
  --global-arg 'clientId=<app-registration-uuid>' \
  --global-arg 'clientSecret=<secret-value>'

# Scan all subscriptions
swamp model method run azure-ai-usage scan_subscriptions

# Discover resources without metrics
swamp model method run azure-ai-usage list_ai_resources
```

## Methods

- **scan_subscriptions** — Fan-out across subscriptions, per-deployment
  breakdown
- **list_ai_resources** — Discover OpenAI/AIServices resources

## Output

```json
{
  "totals": {
    "promptTokens": 800000,
    "generatedTokens": 250000,
    "totalTokens": 1050000,
    "promptTokensPerMinute": 18.5,
    "generatedTokensPerMinute": 5.8
  }
}
```
