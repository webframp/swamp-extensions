## 2026.08.21.2

**Changed:** `globalArguments.subscriptions` now requires at least one
subscription ID. Previously an empty array passed validation and both
`scan_subscriptions` and `list_ai_resources` would silently return zero
resources with no indication that the model was misconfigured.

## 2026.08.21.1

**Changed:** Added `.describe(...)` documentation to previously undocumented
fields in `DeploymentUsageSchema`, `ResourceUsageSchema`, `ResourceListSchema`,
and `ScanResultsSchema` (deployment/resource identity fields, token counts,
period and rate fields, and the `truncated` flag). Tightened `clientSecret`
in `GlobalArgsSchema` to require a non-empty string — an empty secret can
never succeed against Azure AD's token endpoint. No behavioral changes.

## 2026.08.14.4

**Fixed:** three issues surfaced after the #360 dedup fix. First, the ARM
`$filter=kind eq 'OpenAI' or kind eq 'AIServices'` query param sent to the
Cognitive Services list endpoint is not reliably enforced server-side, so
non-token-emitting kinds (Face, ComputerVision, TextAnalytics, etc.) leaked
into discovery and wasted metrics attempts; `listAiResources` now also
filters client-side. Second, resources with zero usage in the lookback
window were silently dropped with no log line at all, indistinguishable from
a resource that was never attempted; `scan_subscriptions` now logs a debug
line before each metrics attempt and an info line for zero-usage outcomes.
Third, per-resource metrics failures logged only `String(err)`, discarding
detail needed to root-cause failures that don't reproduce via `az rest`;
failure logs now include the resource's subscription/resourceGroup/kind and
the raw error's name/message/stack.

## 2026.08.14.3

**Fixed:** `listAiResources` could enumerate the same ARM resource twice
across paginated `nextLink` requests, causing `scan_subscriptions` to process
more candidates than the deduplicated resource count reported by
`list_ai_resources` — surfacing as some resources failing to scan and the
result being marked `truncated: true` even though nothing was actually
throttled or missing. Results are now deduped by ARM resource ID across
pages. Per-page fetch counts and first/last resource IDs are now logged at
debug level to make a repeat of this easier to diagnose from logs alone.

## 2026.08.14.1

**Fixed:** `listAiResources` ignored the ARM API's `nextLink` pagination cursor,
silently dropping resources past the first page.
`GET
.../Microsoft.CognitiveServices/accounts` paginates at a small page size
(observed: 2 per page); a subscription with 10 OpenAI/AIServices accounts was
reporting only 1 in `scan_subscriptions` and `list_ai_resources` output. Both
methods now follow `nextLink` until exhausted.

## 2026.07.31.1

**Fixed:** README incorrectly stated authentication uses `az` CLI (`az login`).
The extension actually uses Azure AD client credentials flow requiring
`tenantId`, `clientId`, and `clientSecret` global arguments. README now
documents the correct auth mechanism, required role (Reader on subscriptions),
and all required global arguments.
