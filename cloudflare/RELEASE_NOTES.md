## 2026.07.18.2

**Added:** An `upgrades` array entry (no-op) to `cache.ts`, `dns.ts`, `waf.ts`,
`worker.ts`, `zone.ts` for proper `typeVersion` tracking on existing instances.
No schema or behavior changes.

## 2026.07.18.1

**Changed:** Renamed the manifest `tags:` field to `labels:` — the schema's
actual field name. No runtime or install behavior change.

## 2026.07.13.1

**Changed:** Pinned the `zod` import specifier to `npm:zod@4.4.3` across all
model files (`zone`, `worker`, `waf`, `dns`, `cache`), matching the version used
by the rest of the repo. Previously these files pinned `4.3.6`. No API or
runtime behavior changes — `4.4.3` is a backward-compatible patch.
