# @webframp/aws/bedrock-usage

AWS Bedrock token usage monitoring — multi-account fan-out scanning of
InputTokenCount and OutputTokenCount metrics via CloudWatch. Provides
per-model breakdowns, tokens-per-minute rates, and invocation stats.

## Authentication

Uses the AWS credential chain. Supports cross-account access via named
profiles with assumed roles (SSO, credential-process, etc.).

## Required IAM Permissions

- `cloudwatch:ListMetrics`
- `cloudwatch:GetMetricData`

## Usage

```bash
# Single account
swamp model create @webframp/aws/bedrock-usage bedrock-usage

# Multi-account with cross-account roles
swamp model create @webframp/aws/bedrock-usage bedrock-usage \
  --global-arg 'profiles=["jw-cd-lab-1/ReadOnlyPlus","jw-broadcasting-soc/ReadOnlyPlus"]' \
  --global-arg 'regions=["us-east-1","us-west-2"]'

# Scan all accounts
swamp model method run bedrock-usage scan_accounts

# Single account/region
swamp model method run bedrock-usage get_token_usage \
  --input profile=jw-cd-lab-1/ReadOnlyPlus --input region=us-east-1

# List active models
swamp model method run bedrock-usage list_active_models
```

## Methods

- **scan_accounts** — Fan-out across all profiles/regions, per-model breakdown
- **get_token_usage** — Single profile/region with model breakdown
- **list_active_models** — Discover models with active metrics

## Output

```json
{
  "totals": {
    "inputTokens": 1250000,
    "outputTokens": 380000,
    "totalTokens": 1630000,
    "inputTokensPerMinute": 28.9,
    "outputTokensPerMinute": 8.8
  }
}
```
