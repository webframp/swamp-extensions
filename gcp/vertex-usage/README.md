# @webframp/gcp/vertex-usage

GCP generative-AI usage and cost analysis, covering both Vertex AI and the
Gemini API (the Gemini Developer API, `generativelanguage.googleapis.com`).
Reads token and request volume from Cloud Monitoring and dollar cost from the
Cloud Billing export in BigQuery, over the same complete UTC days, so the two
can be reconciled.

Results are written as one resource instance per project (`usage-<project>`,
`billing-<project>`). Filter by project, model, publisher, region or date with
CEL / `swamp data query` instead of re-running with different arguments.

## Setup

```bash
swamp model create @webframp/gcp/vertex-usage vertex-usage \
  --global-arg 'serviceAccountJson=<vault:gcp/sa-key>' \
  --global-arg 'billingTable=<billing-project>.<dataset>.gcp_billing_export_v1_<ID>'
```

`projects` is optional. When omitted, every ACTIVE project the credential can
see is discovered. `billingTable` is only needed for the billing methods.
`billingQueryProject` sets the project that runs (and is billed for) BigQuery
jobs; it defaults to the project in `billingTable`.

`billingSchema` is `auto` by default: the table's schema is read to tell the
**standard** usage-cost export (`gcp_billing_export_v1_*`) from the **FOCUS**
export (`gcp_billing_export_focus_*`). Set it to `standard` or `focus` to skip
detection. Both exports are supported, but only the FOCUS path has been verified
against live data; the standard path is covered by unit tests.

## Authentication

In order of precedence:

1. `serviceAccountJson` global argument (service account key, signed-JWT
   exchange). Store it in a swamp vault.
2. `GCP_ACCESS_TOKEN` environment variable (a pre-obtained OAuth2 token, for
   example from CI or `gcloud auth print-access-token`).
3. The file named by `GOOGLE_APPLICATION_CREDENTIALS`, either a service account
   key or an `authorized_user` file from
   `gcloud auth application-default login`.

No `gcloud` CLI dependency. Requested scopes are the minimum for each method:
`monitoring.read`, `cloudplatformprojects.readonly`, `bigquery`.

## Required permissions

| Method                                                   | Grant                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `scan_usage`, legacy scans                               | `roles/monitoring.viewer` (`monitoring.timeSeries.list`) on each target project                   |
| `discover_projects`, `scan_usage` without a project list | `resourcemanager.projects.get`, for example via `roles/browser` at the organization or a folder   |
| `get_billing_costs`, `discover_billing_services`         | `roles/bigquery.dataViewer` on the export dataset and `roles/bigquery.jobUser` on the job project |

Granting Monitoring Viewer at the organization or folder level covers every
project beneath it with one binding.

## Methods

### `discover_projects`

Lists ACTIVE projects through Cloud Resource Manager `projects:search`. Optional
`parents` (`organizations/N`, `folders/N`) limits it to **direct children** of
those resources. Nested folders are not traversed, so for an account-wide view
omit `parents` and grant access at the organization level.

### `scan_usage`

Fan-out scan over the last `days` complete UTC days (default 30, max 90).
Project list precedence: method `projects` argument, then the `projects` global
argument, then runtime discovery. Scans run with bounded `concurrency`
(default 4) and retry 429 and 5xx responses with backoff.

Writes:

- `usage-<project>` per project with usage. `rows` are flat daily records of
  `date, location, publisher, modelId, requestType, sharedRequestType,
  inputTokens, outputTokens, otherTokens, totalTokens, requests, errorRequests,
  rateLimitedRequests`.
  `errorRequests` counts non-2xx `response_code`s (and includes the 429s in
  `rateLimitedRequests`). `byModel` and `totals` are precomputed.
- `scan_summary/current` with the status of **every** scanned project: `ok`,
  `no_data` (metric empty for the window) or `error` (with the message).
  `complete` is `false` if any project errored or was truncated, so a partial
  scan cannot pass for a full one. The method fails outright only if every
  project fails.

Cloud Monitoring keeps these metrics for a limited time, so use
`get_billing_costs` for older history.

Instances are written only for projects that have data and are not removed
later, so a project that errors or goes quiet keeps its previous instance.
`scan_summary` is the authoritative index for the latest run, and every instance
carries the `window` it covers, so check it before comparing instances from
different runs. `complete` is also false when request counts could not be read
for a project.

One run uses a single access token, which lasts about an hour. A scan that
outlives it (thousands of projects at the default pacing) reports the remaining
projects as `error`; narrow it with `projects` or `parents` and run it in parts.

`maxRequestsPerMinute` (default 120) paces Monitoring calls. The default
Monitoring quota is 180 requests per minute per user, and a scan makes two
requests per project, so an unpaced scan of ~100 projects trips it. Requests
that still hit a 429 are retried with a longer backoff (and `Retry-After` when
sent) rather than failing the project.

### `scan_gemini_api_usage`

The same fan-out for the Gemini API, which bills as its own service and does not
appear in Vertex's Monitoring metrics. Takes the same `days`, `projects`,
`parents`, `concurrency` and `maxRequestsPerMinute` arguments.

Writes `gemini-usage-<project>` per project with usage and
`gemini_scan_summary/current` with per-project status (`ok`, `no_data`, `error`)
and `complete`.

Cloud Monitoring is thinner here than for Vertex:

- **Output tokens only.** There is no input-token metric (`inputTokensAvailable`
  is always `false`). Get input volume from `get_billing_costs`.
- `tokenRows` carry `modelId`, `outputModality` and `thinkingEnabled`.
- `requestRows` come from the API-wide `request_count` metric (scoped to the
  Gemini API service), so they cover **every** API method, not only generation.
  Each row has the `method`, `responseCode` and `credentialId`, which is the API
  key behind the call and makes it possible to attribute traffic to a key.
  Request counts are not split by model.

### `discover_billing_services`

Lists billing services and SKUs in the export that match an AI-related regex,
with cost. Run it once to confirm which `service.description` values to filter
on, because partner models can bill under a different service than Google's own.

### `get_billing_costs`

Queries the billing export for the last `days` complete UTC days (max 365) for
the given `services` (default `["Vertex AI", "Gemini API"]`), optionally
narrowed by `skuPattern` and `projects`. All filters are bound query parameters.
Cost is summed as `NUMERIC`, then reported per `currency` and `costType`, which
are never mixed. `cost` is the gross before credits, `credits` is negative, and
`netCost` is the export's own net figure (FOCUS `BilledCost`); a warning is
raised if gross plus credits does not reproduce it.

**Pick the services deliberately.** Gemini spend bills under more than one
service. In one validated account, `Vertex AI` and `Gemini API` each carried
roughly half of the AI cost. Both are included by default; each row keeps its
`service`, so CEL can split them. Other AI products bill separately (for example
Vertex AI Search) and are not included unless you add them. Run
`discover_billing_services` to see what your export contains.

Writes `billing-<project>` per project (`billing-unassigned` for charges with no
project) and `billing_summary/current`. Each row has gross `cost`, `credits`
(negative) and `netCost`. The summary's `complete` is `false` and `warnings`
explains why when the export has not yet caught up to the window end, or when no
rows matched.

### Legacy: `scan_projects`, `get_token_usage`

Single-bucket totals per model with no daily detail, kept for existing
workflows. Prefer `scan_usage`. A project that fails in `scan_projects` now sets
`truncated: true`.

## Querying

```bash
# Everything for one project
swamp data query 'modelName == "vertex-usage" && name == "usage-my-project"'

# Daily rows for one model across all projects
swamp data query 'modelName == "vertex-usage" && dataType == "resource"' \
  --select '{"project": attributes.project, "rows": attributes.rows}'

# Which projects failed the last scan
swamp data query 'modelName == "vertex-usage" && name == "scan_summary"' \
  --select 'attributes.projects'
```

In CEL expressions:

```
data.latest("vertex-usage", "usage-my-project").attributes.totals.totalTokens
data.latest("vertex-usage", "billing_summary").attributes.totals
```

## Reconciling tokens with cost

`scan_usage` and `get_billing_costs` use the same complete UTC days. Check
`billing_summary.complete` and `scan_summary.complete` before trusting a
comparison. Billing is the source of record for money; Monitoring explains
volume by model, region and request type.

For token SKUs the billed quantity is a token count even though the FOCUS export
labels the unit `requests`. In a validated account it agreed with Monitoring to
within about 0.1% for Gemini API output tokens and about 0.3% for Vertex text
models. Media models (image, video) diverged by up to roughly 10%, so treat
those as approximate. Compare by project, day and model, and expect small
differences near the window edges.

Monitoring cannot see everything billing charges for: the Gemini API has no
input-token metric, and other services or unmetered models appear in billing
only.

## Troubleshooting

- **A project shows `no_data`.** Its Vertex metric is empty for the window,
  which is normal for a project that never called Vertex AI.
- **A project shows `error`.** The message is in `scan_summary`. A 403 usually
  means a missing `roles/monitoring.viewer` binding.
- **`requestsAvailable: false`.** Token counts were read but the invocation
  count metric failed; `warnings` has the error. Token totals are still valid.
- **`truncated: true`.** Pagination hit its cap (50 pages per metric), so rows
  are a lower bound. Lower `days` or scan fewer projects per run.
- **`billing_summary.complete` is false.** The export lags usage by hours. Rerun
  later, or exclude the most recent day.
- **No billing rows.** Run `discover_billing_services` and pass the exact
  service name it reports.
- **`GCP token exchange failed`.** The OAuth endpoint rejected the credential,
  most often a revoked service account key. The error includes the HTTP status
  and body.
