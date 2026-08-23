# @webframp/ai-usage

Unified cross-provider AI token usage monitoring — workflow, model, and report
that aggregates Bedrock, Vertex AI, Azure OpenAI, and Anthropic (Claude
Enterprise Analytics) token data into a single view.

Gracefully handles partial provider configurations. Unconfigured providers are
shown with setup hints in the report output.

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

swamp model create @webframp/anthropic/analytics claude-analytics \
  --global-arg 'analyticsKey=<vault-reference>'

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

- **status** — Check which of the four registered providers (Bedrock, Vertex
  AI, Azure OpenAI, Anthropic) have scan data on disk, with a `setup` block
  (command, permissions, authNotes) for each one that doesn't. "Configured"
  here means a scan resource exists for that provider's model instance — not
  that the model instance itself exists. Example:

  ```bash
  swamp model method run ai-usage status
  swamp data get ai-usage status --json | jq '.providers[] | {provider, configured, totalTokens}'
  ```

- **generate** — Reads the latest scan resource for every provider and
  produces the unified `report` resource (grand totals, per-provider
  breakdown, top accounts/models, and highlights). Accepts an optional `days`
  argument (default `30`) that is only used to label the report's
  `periodMinutes` field — it does not filter or re-query the underlying scan
  data, which already reflects whatever lookback window each provider's scan
  method used.

  ```bash
  swamp model method run ai-usage generate --arg days=7
  swamp data get ai-usage report --json | jq '.highlights'
  ```

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

## Troubleshooting

- **A provider I created shows `configured: false` with setup hints, even
  though the model instance exists.** `status` and `generate` never check
  whether the provider's model instance exists — they only check whether a
  scan resource (tagged `specName == scanSpec`, e.g. `scan_results` or
  `userUsage`) has been written for it (`fetchLatestScanData` in
  `extensions/models/ai_usage.ts`). If you created the provider model but
  haven't yet run its scan method (`scan_accounts`, `scan_projects`,
  `scan_subscriptions`, or `collect_user_usage`) — or haven't run
  `swamp workflow run @webframp/ai-usage-scan` — the provider will look
  identical to one that was never configured at all.

- **A provider that should be configured still shows setup hints, and the
  error is swallowed.** `fetchLatestScanData` throws an explicit error if a
  scan resource's `createdAt` metadata isn't a `Date` or `undefined` (a guard
  added after a prior version broke by assuming `createdAt` was always a
  string). Both `status` and `generate` catch *any* error from
  `fetchLatestScanData` — including this one — and just log
  `"Failed to query provider data"` at `warn` level, then report the provider
  as unconfigured. Check logs (or
  `swamp report get @swamp/method-summary --model ai-usage --json`) for that
  warning before assuming a provider genuinely has no data.

- **A configured provider reports 0 tokens, or `lastScanned: null`, after an
  upstream provider extension changes its output shape.** `numField()` reads
  a named key from the scan resource's `totals` object and silently returns
  `0` for any missing key or non-number value — it does not throw. Similarly,
  `lastScanned` is read as `attrs.scannedAt ?? attrs.fetchedAt ?? null`; a
  provider extension using a different timestamp field name will show
  `lastScanned: null` even while `totalTokens` is populated. Both are silent
  field-mapping mismatches, not data-fetch failures — compare the provider's
  raw scan resource (`swamp data get <provider-model> scan_results --json`)
  against the `fields` mapping for that provider in `PROVIDERS`
  (`extensions/models/ai_usage.ts`) if numbers look wrong.

- **`@webframp/ai-usage-report` shows "Not configured" for a provider that
  errors rather than one that's genuinely unconfigured.** The report's
  coverage loop treats a `findBySpec` failure identically to an empty result
  — both log a warning (`"Failed to fetch scan data for provider, treating as
  unconfigured"`) and render the same `⚠️ Not configured` row. A transient
  data-repository error looks exactly like a never-configured provider in the
  rendered table; check the report's own execution logs if a provider you
  know has data still shows as not configured.
