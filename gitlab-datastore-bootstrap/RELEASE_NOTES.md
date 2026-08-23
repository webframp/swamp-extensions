## 2026.08.23.1

**Changed:** Documentation only — no code changes. Added a `## Troubleshooting`
section covering the 401/404 branches in `validateProject`, the 403 branch in
`verifyStateAccess` (needs `api` scope plus Developer role), JSON-parse failures
from `gitlabApi` when self-hosted instances return HTML instead of JSON (wrong
`base_url` or a login redirect), and the Maintainer-role requirement in
`createProjectToken` (which always requests Developer-level tokens regardless of
caller role).
