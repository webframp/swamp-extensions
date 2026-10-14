## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.10.13.1

**Added:** Initial release. `continue_update_rollback` resumes a stack in
UPDATE_ROLLBACK_FAILED, with optional `resourcesToSkip`, and waits for the
rollback to settle.
