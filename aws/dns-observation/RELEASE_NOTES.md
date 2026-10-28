## 2026.10.28.1

**Fixed:** `list_records` reported `status: succeeded` with `zonesScanned`
counting a zone even when that zone's records could not be read. A zone passed
in `zoneFilter` whose `ListResourceRecordSets` call failed (for example, a zone
*name* supplied where a hosted zone *ID* is required) produced
`totalRecords: 0, zonesScanned: 1` — indistinguishable from a successful scan
of a legitimately empty zone. `zonesScanned` now counts only zones whose
records were actually read.

**Added:** `summary.zonesFailed: string[]` lists the zone IDs whose
`ListResourceRecordSets` call failed, so callers can assert on read failures
instead of parsing log warnings.

**Changed:** When an explicit `zoneFilter` is given and *none* of its zones can
be read, `list_records` now throws instead of writing a zero-record success.
The error names the failed zones and reminds the caller that `zoneFilter`
expects hosted zone IDs, not names. A legitimately empty zone (read succeeds,
returns no records) is unaffected and still reports success. A partial failure
(some zones readable, some not) still succeeds, with the unreadable zones listed
in `zonesFailed`.

**Upgrade note:** Additive schema change. `summary.zonesFailed` defaults to
`[]`, so resources stored by earlier versions still validate on read. Consumers
that computed success from `zonesScanned` alone should also check `zonesFailed`.

## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.10.13.1

**Fixed:** `list_zones` and `detect_orphans` failed on current swamp with
`Data name 'latest' is reserved for internal use`. `list_zones` now writes its
`zones` resource as `zone-scan` and `detect_orphans` writes `orphans` as
`orphan-scan`, matching `list_records`' `record-scan`. `list_records` is
unchanged.

**Changed:** The stored data names changed. Anything that addressed the old
`latest` data name, for example `data.latest("<model>", "latest")` or
`name == "latest"`, must use `zone-scan` / `orphan-scan`. The README query
examples named the spec (`zones`, `orphans`) rather than the data name, so they
never matched; they now use the real names. Resource specs and schemas are
unchanged, so consumers that select by spec are unaffected.

## 2026.09.24.1

**Changed:** Bump @aws-sdk/* 3.1133.0 → 3.1139.0 (3 packages)

## 2026.09.18.1

**Upgrade note:** Normalized `npm:zod` dependency version to 4.6.5 across the
repo. No behavioral changes in this extension.
