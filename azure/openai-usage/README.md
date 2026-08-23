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

- **scan_subscriptions** — Fan-out across all configured subscriptions.
  Discovers OpenAI/AIServices resources, queries Azure Monitor for
  `ProcessedPromptTokens`/`GeneratedTokens` over a lookback window (default
  30 days, 1–90 accepted), and returns per-resource totals with a
  per-deployment breakdown. Resources with zero usage in the window are
  silently excluded from the `resources` array (see Troubleshooting).

  ```bash
  swamp model method run azure-ai-usage scan_subscriptions --arg days=7
  ```

- **list_ai_resources** — Discover OpenAI and AI Services resources across
  configured subscriptions without querying metrics. Useful for confirming
  resource discovery/permissions before running a full scan.

## Output

```json
{
  "truncated": false,
  "totals": {
    "promptTokens": 800000,
    "generatedTokens": 250000,
    "totalTokens": 1050000,
    "promptTokensPerMinute": 18.5,
    "generatedTokensPerMinute": 5.8
  }
}
```

`truncated: true` means at least one subscription or resource failed during
the scan — the totals above are a partial picture, not a completed one. See
Troubleshooting.

## Troubleshooting

- **A resource I know has traffic doesn't appear in `scan_subscriptions`
  output.** Resources with zero `ProcessedPromptTokens`/`GeneratedTokens` in
  the lookback window are dropped from the `resources` array entirely — the
  scan logs `"Scanned resource, no usage in period"` at info level and moves
  on (`openai_usage.ts` around line 658). Run `list_ai_resources` first to
  confirm the resource is discovered at all, then widen `days` if the
  activity is older than the current lookback window.

- **`deployments` is empty for a resource that clearly has usage.** The
  per-deployment breakdown is a second, separately-filtered Azure Monitor
  query (`$filter=ModelDeploymentName eq '*'`). If that dimensioned query
  fails or throws, the resource still reports its aggregate
  `promptTokens`/`generatedTokens`, but `deployments` comes back empty and a
  `"Deployment breakdown unavailable for resource"` warning is logged
  (`getTokenMetrics`, `deploymentBreakdownFailed`). This is a degrade, not a
  scan failure — it does not set `truncated`.

- **`truncated: true` in the output.** Set whenever any subscription-level
  discovery call or any per-resource metrics call throws — including
  permission errors, throttling that exhausts retries, or a malformed
  response. The scan continues past the failure rather than aborting, so
  `totals` reflects only what succeeded. Check logs for `"Failed to scan
  subscription"` or `"Failed to get metrics for resource"` entries, which
  include the full error name/message/stack, not just a string.

- **`Azure token exchange failed (401/400): ...` error.** Thrown from
  `getAccessToken` when the client-credentials exchange against
  `login.microsoftonline.com` fails — almost always a wrong `tenantId`,
  `clientId`, or `clientSecret`, or an expired secret. The error body from
  Azure AD is included verbatim in the thrown message.

- **Metrics calls fail even though resource discovery succeeds.** Resource
  discovery only needs `Microsoft.CognitiveServices/accounts/read`; metrics
  need `Microsoft.Insights/metrics/read` as well. Both are covered by the
  built-in Reader role (see Required Permissions above), but a narrower
  custom role that grants only resource-read access will discover resources
  via `list_ai_resources` and then fail metrics lookups during
  `scan_subscriptions` with a 403 from the Azure Monitor endpoint. 403s are
  not retried (`fetchWithRetry` only retries 429/5xx), so they surface
  immediately as a per-resource failure.
