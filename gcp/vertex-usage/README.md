# @webframp/gcp/vertex-usage

GCP Vertex AI token usage monitoring — multi-project scanning of token_count
metrics via the Cloud Monitoring API. Provides per-model breakdowns with
input/output direction split and tokens-per-minute rates.

## Authentication

Uses a GCP service account JSON key (signed JWT exchanged for an access token
with scope `https://www.googleapis.com/auth/monitoring.read`). No `gcloud` CLI
dependency.

Provide the key contents via:

1. The `serviceAccountJson` global argument (preferred — stored in swamp vault), or
2. The `GOOGLE_APPLICATION_CREDENTIALS` environment variable pointing to the key
   file on disk.

## Required Permissions

The service account needs only:

- **Role:** `roles/monitoring.viewer` (Monitoring Viewer) on each target project
- **Permission:** `monitoring.timeSeries.list`

This is the minimum required. Do not grant broader roles like Editor or Owner.

## Usage

```bash
# With service account JSON inline (or reference a vault secret)
swamp model create @webframp/gcp/vertex-usage vertex-usage \
  --global-arg 'projects=["my-project","my-other-project"]' \
  --global-arg 'serviceAccountJson=<contents of service-account.json>'

# Or rely on GOOGLE_APPLICATION_CREDENTIALS env var
swamp model create @webframp/gcp/vertex-usage vertex-usage \
  --global-arg 'projects=["my-project","my-other-project"]'

# Scan all projects
swamp model method run vertex-usage scan_projects

# Single project
swamp model method run vertex-usage get_token_usage --input project=my-project
```

## Methods

- **scan_projects** — Fan-out across all configured projects, per-model
  breakdown
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
