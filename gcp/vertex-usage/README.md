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

- **scan_projects** — Fan-out across all `projects` configured in
  `globalArgs`. Queries each project's `token_count` metrics independently;
  if one project's query throws (auth, permissions, malformed response), that
  project is dropped from the output and a warning is logged, but the scan
  continues for the remaining projects. Writes the `scan_results` resource.
- **get_token_usage** — Single project with model breakdown. Unlike
  `scan_projects`, this method does **not** catch per-project errors — an
  auth failure or Monitoring API error for the requested project fails the
  whole method call. Writes the `single_scan` resource, keyed by project ID.

```bash
# 90-day lookback for one project instead of the 30-day default
swamp model method run vertex-usage get_token_usage \
  --input project=my-project --input days=90
```

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

## Troubleshooting

- **A configured project is missing from `scan_projects` output, with no
  error.** `queryTokenMetrics` treats a Monitoring API error body containing
  `"Cannot find metric"` as "no data" — it returns an empty result set rather
  than throwing (`vertex_usage.ts`, `queryTokenMetrics`). `scan_projects` then
  does `if (data.length === 0) continue;`, silently skipping the project with
  no log line at all. This is the normal outcome for a project that has never
  called Vertex AI, but it looks identical to a misconfigured project. Run
  `get_token_usage` against that specific project — it surfaces the same
  empty result but at least confirms the query ran without an auth error.
- **`scan_projects` succeeds but one project is missing and a warning was
  logged.** Any other failure while querying a project (403 from a missing
  `roles/monitoring.viewer` binding, a network error, malformed JSON from the
  Monitoring API) is caught per-project and logged as `"Failed to scan
  project"` with the raw error string, then that project is dropped from the
  output. Check the model's logs (`context.logger.warn`) for the specific
  project and error — the resource data itself won't tell you why a project
  is absent.
- **`get_token_usage` throws instead of returning an empty result.** This
  method has no per-project try/catch, so the same 403/network/malformed-JSON
  failures that `scan_projects` swallows into a warning will fail the whole
  method call here. This is expected — it's the tradeoff for single-project
  precision — but it means transient Monitoring API errors are more visible
  on this path than on `scan_projects`.
- **`truncated: true` in the output.** `queryTokenMetrics` caps pagination at
  `MAX_PAGES = 50`. If a project's time series still has a `nextPageToken`
  after 50 pages, the loop stops and `truncated` is set `true` for that
  project (and propagates to `anyTruncated` in `scan_projects`). Token totals
  and per-model breakdowns are then a lower bound, not the full period —
  narrow the `days` argument to reduce the number of series/pages returned.
- **Auth errors on startup.** `resolveServiceAccount` throws a specific
  message for each failure mode: no `serviceAccountJson` and no
  `GOOGLE_APPLICATION_CREDENTIALS` set; a `GOOGLE_APPLICATION_CREDENTIALS`
  path that can't be read; JSON that fails to parse; or JSON missing
  `client_email`/`private_key`. Read the thrown message directly — it
  identifies which of these four cases occurred rather than a generic "auth
  failed".
- **`GCP token exchange failed` error.** The signed JWT was rejected by
  Google's OAuth endpoint (`getAccessToken`). The error includes the HTTP
  status and response body from `https://oauth2.googleapis.com/token` —
  common causes are a revoked/deleted service account key, or a `token_uri`
  in the key JSON that no longer matches Google's endpoint. This happens
  before any per-project logic runs, so it fails both methods identically.
