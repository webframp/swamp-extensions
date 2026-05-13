# @webframp/gcp/vertex-usage

GCP Vertex AI token usage monitoring — multi-project scanning of
token_count metrics via the Cloud Monitoring API. Provides per-model
breakdowns with input/output direction split and tokens-per-minute rates.

## Authentication

Uses `gcloud auth print-access-token` (Application Default Credentials).
Requires an authenticated gcloud CLI session.

## Required Permissions

- `monitoring.timeSeries.list` on each project

## Usage

```bash
swamp model create @webframp/gcp/vertex-usage vertex-usage \
  --global-arg 'projects=["jw-cd-apps-ai","jw-avs-genmedia"]'

# Scan all projects
swamp model method run vertex-usage scan_projects

# Single project
swamp model method run vertex-usage get_token_usage --input project=jw-cd-apps-ai
```

## Methods

- **scan_projects** — Fan-out across all configured projects, per-model breakdown
- **get_token_usage** — Single project with model breakdown

## Output

```json
{
  "totals": {
    "inputTokens": 500000,
    "outputTokens": 120000,
    "totalTokens": 620000,
    "inputTokensPerMinute": 11.6,
    "outputTokensPerMinute": 2.8
  }
}
```
