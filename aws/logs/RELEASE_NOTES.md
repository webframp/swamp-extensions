## 2026.07.30.1

**Added:** Optional `profile` global argument for multi-account credential resolution.
When set, credentials resolve via `fromIni` (supports SSO token cache and shared-config
profiles). When omitted, the default credential chain applies as before. Fully backward
compatible — no changes required for existing instances.

**Changed:** Internal client construction extracted into a shared `makeClient` helper.
No behavioral difference for instances without a `profile` set.
