## 2026.08.21.1

**Changed:** Tightened `apiToken`, `zoneId`, and `accountId` in the global
arguments schema of `cache.ts`, `dns.ts`, `waf.ts`, `worker.ts`, and `zone.ts`
to require non-empty strings (`.min(1)`), since every API call built from
these values fails immediately if they are blank. Applied the same
non-empty-string constraint to required identifier arguments (`recordId`,
`ruleId`, `scriptName`, `routeId`, and `zoneId` on per-method arguments) across
these models. No behavioral change for valid input — this only rejects
already-invalid empty-string input earlier.

## 2026.08.13.1

**Fixed:** The `deploy` method now correctly maps bindings to the field names
the Cloudflare API expects. Previously, all binding types sent `value` as the
field name, but the API requires `text` for plain_text/secret_text,
`namespace_id` for kv_namespace, `bucket_name` for r2_bucket, and `class_name`
for durable_object_namespace. Deployments with plain_text or secret_text
bindings failed with "invalid or missing text property"; other binding types
were silently ignored.

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
