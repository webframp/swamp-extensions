## 2026.08.21.2

**Changed:** Cloudflare API failures now surface with the HTTP method, path,
and status instead of a bare `Cloudflare API error: <message>`. This applies
across every method in `cache.ts`, `dns.ts`, `waf.ts`, `worker.ts`, and
`zone.ts`, since all of them share the `_lib/api.ts` request helpers. A
non-JSON response (e.g. a gateway timeout page) or a network-level fetch
failure previously bubbled up as a cryptic parse error or unhandled
rejection; both now say what request was being attempted.

The GraphQL-backed methods (`waf.get_security_events`,
`cache.get_analytics`) now check `response.ok` and the GraphQL `errors`
field before reading data, and report the zone ID on failure. A network
error during `worker.deploy` or `worker.get_script` (source-code fetch) and
`dns.export` now names the script or zone instead of throwing an unhandled
rejection.

**Changed:** `dns.create` and `dns.update` now reject MX and SRV records
that omit `priority` at validation time — Cloudflare rejects these deep
inside the API with a less specific error. `cache.purge_urls` requires 1-30
URLs (previously unbounded, including empty); `cache.purge_tags` and
`cache.purge_prefixes` require at least one entry. `cache.get_analytics`
requires `since`/`until` to be numeric strings — a non-numeric value
previously produced a `RangeError` from `Date.toISOString()` with no
indication of which argument was bad. `waf.create_rule` and
`waf.toggle_rule` now throw a specific error if Cloudflare returns an empty
rule/filter list instead of crashing on `undefined.id`.

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
