## 2026.10.22.3

**Changed:** `master_password` (global argument) and the `connectionString` and
`datastoreConfig` fields of the provision result are now marked sensitive. Swamp
stores their values in a vault and persists a `${{ vault.get(...) }}` reference
in place of the plaintext, instead of writing the live database password into
state. `connectionString` embeds the password and `datastoreConfig` is a JSON
blob that embeds `connectionString`, so both carried the credential in cleartext
before this release.

**Upgrade note:** No action required for the global argument — the README and
manifest already instruct passing `master_password` as a
`${{ vault.get("aurora", "MASTER_PASSWORD") }}` expression. For stored results:
any automation that read `connectionString` or `datastoreConfig` directly from
`swamp data` now receives a vault reference and must resolve it through the
vault rather than reading a literal value. The `upgrades` chain gains an
identity entry terminating at this version so existing definitions migrate
cleanly.

## 2026.10.22.2

**Fixed:** The README and manifest Quick Start documented `master_password` as a
literal `--input master_password=...` value. Workflow `--input` values are
recorded in cleartext in the run history, so a password written that way leaks.
The docs now store the password with `swamp vault put aurora MASTER_PASSWORD`
(which prompts for the value) and pass it as a
`${{ vault.get("aurora", "MASTER_PASSWORD") }}` expression, which swamp redacts.
This earns the registry `secret-safe-docs` quality factor.

**Changed:** Docs only. No model schema, method, or behavior change. The
`upgrades` chain gains an identity entry terminating at this version so existing
definitions migrate cleanly.

**Upgrade note:** No action required. On the next method run, each existing
definition's `typeVersion` advances to 2026.10.22.2 with its global arguments
preserved.

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
