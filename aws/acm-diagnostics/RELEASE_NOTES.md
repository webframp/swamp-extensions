## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.10.13.1

**Added:** Initial release. Read-only ACM diagnostics: `list_certificates`
(status and domain filters) and `describe_certificates` (per-domain validation
status, expected DNS records, failure reason, in-use resources, and a roll-up of
pending, in-use, missing, and errored certificates).
