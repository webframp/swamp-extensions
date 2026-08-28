## 2026.08.28.1

**Changed:** Bump @webframp/terraform 2026.08.20.1 → 2026.08.26.3

**Changed:** Bump @webframp/aws/inventory 2026.08.20.1 → 2026.08.26.3

**Changed:** Bump @webframp/aws/networking 2026.08.20.1 → 2026.08.26.2

## 2026.08.26.1

**Changed:** Normalized `deno.json` configuration for repo-wide consistency:
added explicit `compilerOptions.strict` and migrated zod dependency to the
import map (bare `"zod"` specifier instead of inline `npm:zod@4.4.3`). No
behavioral changes — runtime resolution is identical.
