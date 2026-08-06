## 2026.08.05.1

**Changed:** Bump @aws-sdk/* 3.1101.0 → 3.1104.0 (2 packages)

## 2026.08.02.1

**Changed:** Bump @aws-sdk/* 3.1100.0 → 3.1101.0 (2 packages)

## 2026.08.01.1

**Fixed:** Broken model-upgrade chain. The prior version bump (to `2026.07.31.1`) updated `version` but left the `upgrades` array terminating one step short, which blocks `swamp extension push` ("model upgrade chain errors"). That version never actually published — the registry was still serving `2026.07.30.1`. This release closes the chain with a no-op upgrade entry and republishes everything that had accumulated since `2026.07.30.1`.

## 2026.07.31.1

**Changed:** Bump @aws-sdk/* 3.1096.0 → 3.1100.0 (2 packages)

## 2026.07.30.1

**Added:** Optional `profile` global argument for multi-account credential resolution.
When set, credentials resolve via `fromIni` (supports SSO token cache and shared-config
profiles). When omitted, the default credential chain applies as before. Fully backward
compatible — no changes required for existing instances.

