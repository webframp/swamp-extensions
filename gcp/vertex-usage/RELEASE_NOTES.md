## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.10.12.1

**Fixed:** A Monitoring 401 or 403 whose message contained "Cannot find metric"
marked the project `no_data`, so a project we could not read looked like a
complete scan with zero tokens. Only a 404 or 400 with that message now counts
as no data. Any other status on the token metric marks the project `error` and
`scan_summary.complete` false; on a request-count metric the project keeps its
token rows with `requestsAvailable: false`; in the legacy `scan_projects` it
sets `truncated: true`.

**Fixed:** A BigQuery response that omitted `jobComplete` skipped polling and
returned zero rows, so the billing methods reported an empty result. The job is
now polled until `jobComplete` is true, and a response with no job id to poll
fails with a clear error.

**Fixed:** If a retried 429 or 5xx response failed to cancel its body, the
cancel error replaced the retry and failed the request. The cancel is now
best-effort.

**Changed:** `scan_projects` and `get_token_usage` dropped tokens whose
direction label was neither input nor output (for example cached tokens), so
their `totalTokens` could be lower than `scan_usage` for the same window. Those
tokens now appear in a new `otherTokens` field on each model, each project and
the totals, and count toward `totalTokens`. Legacy totals rise for any project
that reports such a direction.

**Added:** README troubleshooting entries for a BigQuery 403 with narrowly
scoped `authorized_user` credentials, and for a scan in which every project is
`no_data`.

**Upgrade note:** `otherTokens` is optional in the legacy schemas, so stored
resources from earlier versions still validate. No global argument changes and
no co-upgrades. `@webframp/ai-usage` reads `scan_projects` totals, so its Vertex
`totalTokens` now includes other tokens and can exceed input plus output.
