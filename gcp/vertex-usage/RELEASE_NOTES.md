## 2026.08.21.2

**Changed:** The `projects` global argument now requires at least one non-empty
project ID; previously an empty list silently produced a scan of zero projects
with no explanation. Service-account credential loading errors — a missing or
unreadable `GOOGLE_APPLICATION_CREDENTIALS` file, or a malformed JSON key — now
name the path/field that failed instead of surfacing a bare filesystem or
`JSON.parse` error. Cloud Monitoring API failures now include the response body
and the project ID in the error message instead of just an HTTP status code, and
a malformed JSON response from either the OAuth token endpoint or the Monitoring
API now raises a clear "returned malformed JSON" error naming the request that
failed.

## 2026.08.21.1

**Changed:** Added `.describe(...)` documentation to previously undocumented
fields in `ModelUsageSchema`, `ProjectUsageSchema`, and `ScanResultsSchema`
(model/project identity fields, token counts, period and rate fields, and
the `truncated` flag). Tightened the `project` argument on `get_token_usage`
to require a non-empty string. No behavioral changes.

## 2026.07.31.1

**Fixed:** README incorrectly stated authentication uses `gcloud` CLI
(Application Default Credentials). The extension actually uses a service account
JSON key with signed JWT exchange. README now documents the correct auth
mechanism, required role (`roles/monitoring.viewer`), and all global arguments.
