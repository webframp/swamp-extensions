## 2026.07.31.1

**Fixed:** README incorrectly stated authentication uses `gcloud` CLI
(Application Default Credentials). The extension actually uses a service account
JSON key with signed JWT exchange. README now documents the correct auth
mechanism, required role (`roles/monitoring.viewer`), and all global arguments.
