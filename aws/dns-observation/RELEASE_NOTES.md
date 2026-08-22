## 2026.08.21.1

**Changed:** Route53/STS API failures across `list_zones`, `list_records`,
and `detect_orphans` now raise or log an error naming the failing operation
(`GetCallerIdentity`, `ListHostedZones`, `GetHostedZone`,
`ListResourceRecordSets`) plus the relevant zone ID or page number, instead of
either propagating a raw SDK error with no context or, in the case of
non-critical lookups, swallowing the failure silently.

**Changed:** Warnings for missing upstream data in `detect_orphans` (stored
record scan, inventory data, adopt data) now include the underlying error
message instead of a generic "could not read" note with no detail.

**Changed:** `inventoryModelName` and `adoptModelName` on `detect_orphans`
now require non-empty strings instead of accepting an empty string that would
silently fail to match any stored data.
