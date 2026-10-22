## 2026.10.22.1

**Fixed:** Existing definitions created against an earlier version were stranded
on upgrade. The model shipped new versions without a corresponding `upgrades`
chain, so swamp could not migrate a definition's `typeVersion` and logged a
warning that global arguments would not be migrated. This release backfills the
full upgrade chain through every shipped version and terminates it at the
current version, so stale definitions migrate cleanly. The transform is identity
— no stored global argument value changes.

**Upgrade note:** No action required. On the next method run, each existing
definition's `typeVersion` advances to 2026.10.22.1 with its global arguments
preserved.

## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry
quality rubric scores a declared license separately from the bundled
`LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.09.18.1

**Upgrade note:** Normalized `npm:zod` dependency version to 4.6.5 across the
repo. No behavioral changes in this extension.
