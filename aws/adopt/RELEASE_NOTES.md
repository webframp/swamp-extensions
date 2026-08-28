## 2026.08.28.1

**Changed:** Bump @aws-sdk/* 3.1114.0 → 3.1120.0 (5 packages)

**Changed:** Bump @swamp/aws/ec2 2026.08.20.1 → 2026.08.28.1

**Changed:** Bump @swamp/aws/rds 2026.08.19.1 → 2026.08.28.1

**Changed:** Bump @swamp/aws/secretsmanager 2026.08.20.1 → 2026.08.28.1

## 2026.08.26.3

**Fixed:** Restored inline `npm:zod@4.4.3` import specifiers so the registry
quality scorer can resolve dependencies and score the extension. An earlier
release used a bare `"zod"` import-map specifier, which published but scored as
unscored.

**Changed:** Retained explicit `compilerOptions.strict` in `deno.json`. No
behavioral or schema changes.
