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
