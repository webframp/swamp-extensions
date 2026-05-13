# @webframp/ai-usage

Unified cross-provider AI token usage monitoring — workflow, model, and
report that aggregates Bedrock, Vertex AI, and Azure OpenAI token data
into a single view.

Gracefully handles partial provider configurations. Unconfigured providers
are shown with setup hints in the report output.

## Quick Start

```bash
# Pull the extension (also pulls provider dependencies)
swamp extension pull @webframp/ai-usage

# Configure providers you use (any subset works)
swamp model create @webframp/aws/bedrock-usage bedrock-usage \
  --global-arg 'profiles=["default"]' --global-arg 'regions=["us-east-1"]'

swamp model create @webframp/gcp/vertex-usage vertex-usage \
  --global-arg 'projects=["my-project"]'

swamp model create @webframp/azure/openai-usage azure-ai-usage \
  --global-arg 'subscriptions=["sub-id"]'

# Create the unified model
swamp model create @webframp/ai-usage ai-usage

# Check provider status
swamp model method run ai-usage status

# Run the full scan workflow
swamp workflow run @webframp/ai-usage-scan

# Or generate report from existing data
swamp model method run ai-usage generate
```

## Methods

- **status** — Check which providers are configured, with setup hints
- **generate** — Produce unified report from collected scan data

## Workflow

- **@webframp/ai-usage-scan** — Orchestrates scan across all configured
  providers then generates the unified report

## Report

- **@webframp/ai-usage-report** — Workflow-scope report for standalone use

## Output

```json
{
  "grandTotals": {
    "inputTokens": 2550000,
    "outputTokens": 750000,
    "totalTokens": 3300000,
    "inputTokensPerMinute": 59.0,
    "outputTokensPerMinute": 17.4
  }
}
```
