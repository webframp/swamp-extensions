# @webframp/aws/bedrock-usage

AWS Bedrock token usage monitoring — multi-account fan-out scanning of
InputTokenCount and OutputTokenCount metrics via CloudWatch. Provides per-model
breakdowns, tokens-per-minute rates, and invocation stats.

## Authentication

Uses the AWS credential chain. Supports cross-account access via named profiles
with assumed roles (SSO, credential-process, etc.).

## Required IAM Permissions

- `cloudwatch:ListMetrics`
- `cloudwatch:GetMetricData`

## Usage

```bash
# Single account
swamp model create @webframp/aws/bedrock-usage bedrock-usage

# Multi-account with cross-account roles
swamp model create @webframp/aws/bedrock-usage bedrock-usage \
  --global-arg 'profiles=["my-account/ReadOnlyPlus","my-other-account/ReadOnlyPlus"]' \
  --global-arg 'regions=["us-east-1","us-west-2"]'

# Scan all accounts
swamp model method run bedrock-usage scan_accounts

# Single account/region
swamp model method run bedrock-usage get_token_usage \
  --input profile=my-account/ReadOnlyPlus --input region=us-east-1

# List active models
swamp model method run bedrock-usage list_active_models
```

## Methods

- **scan_accounts** — Fan-out across all configured `profiles` x `regions`
  pairs. For each pair, skips it entirely (no entry in `accounts`) if both
  `inputTokens` and `outputTokens` are zero for the lookback window, then
  fetches a per-model breakdown for the pairs that do have usage. Writes a
  single `scan_results` resource named `current`, so a re-run overwrites
  the previous scan rather than accumulating history.
- **get_token_usage** — Same per-model breakdown logic as `scan_accounts`
  but scoped to one profile/region (defaulting to the first entries in the
  `profiles`/`regions` global args, or `"default"`/`"us-east-1"` if those
  lists are empty). Writes to `single_scan/<profile>-<region>`.
- **list_active_models** — Lists Bedrock model IDs with an `InputTokenCount`
  metric published in CloudWatch for the given profile/region — i.e. "has
  this model been invoked recently," not "is this model enabled for the
  account." Writes to `active_models/<profile>-<region>`.

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

## Troubleshooting

- **An account/region you expect to see is missing from `scan_accounts`
  output, with no error and `truncated: false`.** This is expected
  behavior, not a failure: `scan_accounts` calls `continue` for any
  profile/region pair where `InputTokenCount` and `OutputTokenCount` both
  sum to zero over the lookback window, and that skip does not set
  `truncated`. Run `get_token_usage` directly against that profile/region
  to confirm there's genuinely no usage rather than a metrics delay.
- **Results only cover `us-east-1` and `us-west-2` even though you scan
  other regions in Bedrock.** The `regions` global arg defaults to
  `["us-east-1", "us-west-2"]`. Bedrock CloudWatch metrics are
  regional — usage in `eu-west-1`, `ap-southeast-2`, etc. will silently
  produce no data unless you pass `--global-arg 'regions=[...]'` including
  those regions.
- **`truncated: true` with no explanation of what was cut.** This flag is
  overloaded across two independent mechanisms: (1) `ListMetrics` pagination
  hit the hardcoded `MAX_PAGES = 50` cap while enumerating model IDs, so
  some active models may be missing from the breakdown; (2) one or more
  per-model `GetMetricData` calls in a batch (5 models at a time) failed
  and were caught, contributing a `0`-token, dropped entry instead of
  failing the whole scan. There's no per-model indication of which case
  applied — treat `truncated: true` as "the model breakdown is incomplete,"
  and re-run `get_token_usage` for a specific `modelId`'s window to check
  it individually if the total looks low.
- **`accountId` is always `null` in every account entry.** It is never
  resolved via STS (`GetCallerIdentity`) — the code comments this off as
  an added-latency tradeoff. If you scan multiple profiles that assume
  roles into the same underlying account, disambiguate them by `profile`
  name, not `accountId`.
- **`AccessDenied` or credential errors on `ListMetrics`/`GetMetricData`.**
  Any `profile` other than the literal string `"default"` is resolved via
  `fromIni({ profile })`, so it must exist in your `~/.aws/config` /
  `~/.aws/credentials` (including SSO or `credential_process` profiles).
  `"default"` bypasses `fromIni` entirely and uses the ambient AWS
  credential chain (env vars, instance role, etc.) instead of the
  `[default]` profile block specifically — errors thrown from either path
  are wrapped with the failing `profile`/`region`/`modelId` in the message
  to make this distinction easier to spot in logs.
