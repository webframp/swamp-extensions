## 2026.07.31.1

**Changed:** Bump @aws-sdk/* 3.1096.0 → 3.1100.0 (5 packages)

**Changed:** Bump @swamp/aws/ec2 2026.07.27.1 → 2026.07.30.1

**Changed:** Bump @swamp/aws/rds 2026.07.27.1 → 2026.07.30.1

**Changed:** Bump @swamp/aws/secretsmanager 2026.07.27.1 → 2026.07.30.1

## 2026.07.30.1

**Added:** Optional `profile` global argument for multi-account credential resolution.
When set, credentials resolve via `fromIni` (supports SSO token cache and shared-config
profiles). When omitted, the default credential chain applies as before. Fully backward
compatible — no changes required for existing instances.

