## 2026.07.21.1

**Changed:** Authentication no longer shells out to `gcloud auth print-access-token`. Auth now uses a GCP service account JSON key — the extension signs a JWT (RS256) and exchanges it for an access token at Google's token endpoint. This eliminates the `gcloud` CLI runtime dependency.

**Added:** `serviceAccountJson` optional global argument (sensitive). Accepts a stringified service account JSON key. Falls back to reading the file at `GOOGLE_APPLICATION_CREDENTIALS` if omitted.

**Upgrade note:** Existing model instances must provide credentials via one of:
1. `--global-arg 'serviceAccountJson=<vault:path/to/sa-key>'` (recommended)
2. Set `GOOGLE_APPLICATION_CREDENTIALS` env var pointing to a key file

The extension no longer requires `gcloud` to be installed or authenticated.
