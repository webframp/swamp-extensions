## 2026.08.23.1

**Changed:** Documentation only — no code changes. Clarified the behavioral
difference between `scan_projects` (per-project try/catch, warns and
continues) and `get_token_usage` (no catch — a single project's failure
fails the whole call), with a new `days=90` usage example. Added a
`## Troubleshooting` section covering the silent per-project skip when a
metric query returns "Cannot find metric," the warn-and-drop path for
genuine per-project failures, the `MAX_PAGES = 50` pagination cap, the four
thrown-error cases in `resolveServiceAccount`, and the `GCP token exchange
failed` error format from `getAccessToken`.
