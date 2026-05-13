# @webframp/azure/openai-usage

Azure OpenAI / AI Services token usage monitoring — multi-subscription
scanning of ProcessedPromptTokens and GeneratedTokens via Azure Monitor.
Auto-discovers CognitiveServices resources and provides per-deployment
breakdowns.

## Authentication

Uses `az` CLI authentication (az login). Requires an active session.

## Required Permissions

- Reader role on target subscriptions
- `Microsoft.CognitiveServices/accounts/read`
- `Microsoft.Insights/metrics/read`

## Usage

```bash
swamp model create @webframp/azure/openai-usage azure-ai-usage \
  --global-arg 'subscriptions=["cef96095-...","690e5f6d-..."]'

# Scan all subscriptions
swamp model method run azure-ai-usage scan_subscriptions

# Discover resources without metrics
swamp model method run azure-ai-usage list_ai_resources
```

## Methods

- **scan_subscriptions** — Fan-out across subscriptions, per-deployment breakdown
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
