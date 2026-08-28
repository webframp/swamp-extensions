## 2026.08.28.1

**Changed:** Bump @webframp/aws/bedrock-usage 2026.08.20.1 → 2026.08.26.2

**Changed:** Bump @webframp/gcp/vertex-usage 2026.07.31.1 → 2026.08.26.2

**Changed:** Bump @webframp/azure/openai-usage 2026.08.14.4 → 2026.08.26.2

**Changed:** Bump @webframp/anthropic/analytics 2026.08.14.1 → 2026.08.26.2

## 2026.08.26.2

**Fixed:** Restored inline `npm:zod@4.4.3` import specifiers so the registry
quality scorer can resolve dependencies and score the extension. An earlier
release used a bare `"zod"` import-map specifier, which published but scored as
unscored.

**Changed:** Retained explicit `compilerOptions.strict` in `deno.json`. No
behavioral or schema changes.
