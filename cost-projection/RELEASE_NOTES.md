## 2026.10.22.1

**Fixed:** All three models (`gpu-cloud`, `gpu-rental`, `gpu-capex`) shipped new versions without an `upgrades` chain, so existing definitions never had their `typeVersion` stamped forward and showed as `stranded`. This release backfills the full upgrade chain through every shipped version for each model, terminating at the current version. The models declare no global arguments (`globalArguments: z.object({})`), so nothing was ever at risk of being dropped; the chains exist to stamp `typeVersion` and satisfy the upgrade-chain rule. All transforms are identity.

**Upgrade note:** No action required. On the next method run, each existing definition's `typeVersion` advances to 2026.10.22.1.

## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.09.19.1

**Changed:** Removed the deprecated `drivers:` manifest key. Swamp core removed
extension driver support (swamp-club/swamp#2333, 2026-09-01); the key now emits
a deprecation warning and is ignored by the manifest parser. The field was an
empty list, so this is a no-op for behavior — the extension ships the same three
models and one report as before.

**Upgrade note:** No migration required. No model schema, method, or resource
changed.
