## 2026.11.03.1

**Changed:** The scaffolded `deno.json` now pins
`@swamp-club/swamp-testing@0.20261030.68` (was `0.20260928.39`). Newly
scaffolded extensions pick up the current testing-library release. No schema or
behavioral changes to the model itself; existing scaffolded extensions are
unaffected until regenerated.

## 2026.10.14.2

**Added:** `scaffold` takes an optional `license` argument: an SPDX expression
such as `Apache-2.0`, `MIT`, or `MIT OR Apache-2.0`. When given, the scaffolded
`manifest.yaml` declares `license: <spdx>` directly after `name:`, lists
`LICENSE.md` under `additionalFiles:`, and the generated `LICENSE.md` is a
placeholder (identifier, copyright line, link to spdx.org) that you replace
with the full license text. The generated `mod.ts` header carries the same
SPDX identifier. Ids come from a short allow-list of common licenses in exact
SPDX case; `LicenseRef-*` and unrecognised ids are rejected.

**Changed:** There is no default license. Without `license`, the scaffold logs
a warning and emits no `license:` line and no `LICENSE.md`, so the result scores
below 100% on `swamp extension quality` until you add them. The generated
`mod.ts` no longer hard-codes `// SPDX-License-Identifier: Apache-2.0`; the
header appears only when you pass `license`.

**Upgrade note:** No schema changes. Existing stored scaffold data is unaffected.
