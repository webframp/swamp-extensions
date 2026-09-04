## 2026.09.04.1

**Changed:** Bump @webframp/aws/bedrock-usage 2026.08.28.1 → 2026.08.29.1

**Changed:** Bump @webframp/gcp/vertex-usage 2026.08.26.2 → 2026.08.28.1

**Changed:** Bump @webframp/azure/openai-usage 2026.08.26.2 → 2026.08.28.1

**Changed:** Bump @webframp/anthropic/analytics 2026.08.26.2 → 2026.08.28.1

## 2026.08.28.3

**Changed:** Normalized the extension license to Apache-2.0 and corrected the
copyright holder to "Sean Escriva". Extensions that previously shipped an MIT
LICENSE.md are now Apache-2.0, consistent with the repository root and every
other extension. No code or behavioral changes.

**Upgrade note:** License text only. No API, schema, or runtime behavior
changed.

## 2026.08.28.2

**Fixed:** Re-pinned `@webframp/aws/bedrock-usage` to 2026.08.28.1 — the version
published in the prior sweep. The 2026.08.28.1 release of this composite still
pinned the pre-sweep 2026.08.26.2, so its dependency graph did not deliver the
AWS SDK 3.1120.0 bump. The GCP, Azure, and Anthropic usage leaves were not part
of the sweep and remain at 2026.08.26.2. No schema or behavioral changes.

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
