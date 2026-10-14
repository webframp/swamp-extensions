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
