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
