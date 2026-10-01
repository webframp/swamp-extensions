## 2026.10.01.1

**Fixed:** `scan_projects` set no flag when a project failed to scan, so a
partial scan looked complete. A failed project now sets `truncated: true`.
Monitoring requests that hit a 429 or 5xx are retried with backoff instead of
failing the project on the first response. `billing_summary.complete` is now
`false` when no billing rows match the filters, so a wrong service name no
longer reads as a valid empty result.

**Added:** Gemini API coverage and cost analysis alongside Vertex AI.

- `discover_projects`, and project discovery in every scan, find ACTIVE projects
  through Cloud Resource Manager. `projects` is now optional.
- `scan_usage` writes daily token and request rows per project, location,
  publisher, model and request type, with error and 429 counts, as one
  `usage-<project>` instance per project. `scan_summary` records every project
  as `ok`, `no_data` or `error`, and `complete` is false if any project failed.
- `scan_gemini_api_usage` does the same for the Gemini API: daily output tokens
  by model, and API-wide request counts by method, response code and API key.
  Monitoring has no input-token metric for this API, so input volume comes from
  billing. `gemini_usage.requestsAvailable` is false when request counts could
  not be read, and the scan's `complete` follows it.
- Daily Monitoring points are assigned to a day by the midpoint of their
  interval, so an inclusive or missing `endTime` cannot shift a point to the
  neighbouring day.
- `discover_billing_services` and `get_billing_costs` read the Cloud Billing
  export in BigQuery. Gross cost, credits and net cost are reported per day,
  project and SKU, never mixing currencies or cost types. Both the standard and
  the FOCUS export are supported (`billingSchema`, auto-detected). The standard
  export path is covered by unit tests only.
- Authentication also accepts `GCP_ACCESS_TOKEN` and `authorized_user` files
  named by `GOOGLE_APPLICATION_CREDENTIALS`.
- New optional global arguments: `billingTable`, `billingSchema`,
  `billingQueryProject`.

**Changed:** `scan_projects` and `get_token_usage` keep their output schemas.
`scan_projects` now discovers projects when none are configured. Scans pace
Monitoring calls with `maxRequestsPerMinute` (default 120) to stay under the
default quota of 180 requests per minute per user. A `GCP_ACCESS_TOKEN`
environment variable now takes precedence over `GOOGLE_APPLICATION_CREDENTIALS`
when both are set, so unset a stale token if a host exports one for another
tool. `maxRequestsPerMinute` paces first attempts only: a retry no longer takes
a limiter slot, but retries still count against Google's quota, so leave
headroom below the real limit. A BigQuery response with no job id now fails with
its own message instead of reporting a timeout or a page-cap error.

**Upgrade note:** Existing definitions keep working without changes, and
`@webframp/ai-usage` needs no co-upgrade. The billing methods need
`billingTable`, BigQuery Data Viewer on the export dataset and BigQuery Job User
on the project that runs the query. Project discovery needs
`resourcemanager.projects.get`.
