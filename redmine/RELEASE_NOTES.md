## 2026.07.18.1

**Added:** An `upgrades` array entry (no-op) to `redmine.ts` for proper `typeVersion` tracking on existing instances. No schema or behavior changes.

## 2026.07.09.1

**Fixed:** Extension failed to load with `Last upgrade toVersion "2026.06.21.1"
does not match model version "2026.07.08.1" for model type
"@webframp/redmine"`. #194 bumped the model's `version` field to match the
manifest but never added a matching `upgrades` entry, leaving the upgrade
chain one version short of the declared model version — a rule the registry
enforces at load time. This adds the missing no-op upgrade entry and bumps the
version again so the chain is complete. No behaviour change beyond #194.
