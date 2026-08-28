## 2026.08.28.3

**Changed:** Normalized the extension license to Apache-2.0 and corrected the
copyright holder to "Sean Escriva". Extensions that previously shipped an MIT
LICENSE.md are now Apache-2.0, consistent with the repository root and every
other extension. No code or behavioral changes.

**Upgrade note:** License text only. No API, schema, or runtime behavior
changed.

## 2026.08.28.2

**Fixed:** Re-pinned the eight bumped `@webframp/aws/*` leaf dependencies (logs,
metrics, alarms, traces, inventory, networking, alarm-investigation,
cost-explorer) to 2026.08.28.1 — the versions published in the prior sweep. The
2026.08.28.1 release of this composite still pinned the pre-sweep 2026.08.26.x
leaf versions (SDK 3.1114.0), so its dependency graph did not deliver the AWS SDK
3.1120.0 bump it was bumped alongside. `@webframp/github` was not part of the
sweep and remains at 2026.08.26.3. No schema or behavioral changes.

## 2026.08.28.1

**Changed:** Bump @webframp/aws/logs 2026.08.20.1 → 2026.08.26.3

**Changed:** Bump @webframp/aws/metrics 2026.08.20.1 → 2026.08.26.3

**Changed:** Bump @webframp/aws/alarms 2026.08.20.1 → 2026.08.26.3

**Changed:** Bump @webframp/aws/traces 2026.08.20.1 → 2026.08.26.3

**Changed:** Bump @webframp/aws/inventory 2026.08.20.1 → 2026.08.26.3

**Changed:** Bump @webframp/aws/networking 2026.08.20.1 → 2026.08.26.2

**Changed:** Bump @webframp/aws/alarm-investigation 2026.08.20.1 → 2026.08.26.2

**Changed:** Bump @webframp/aws/cost-explorer 2026.08.20.1 → 2026.08.26.2

**Changed:** Bump @webframp/github 2026.07.18.1 → 2026.08.26.3

## 2026.08.26.1

**Changed:** Normalized `deno.json` configuration for repo-wide consistency:
added explicit `compilerOptions.strict` and migrated zod dependency to the
import map (bare `"zod"` specifier instead of inline `npm:zod@4.4.3`). No
behavioral changes — runtime resolution is identical.
