## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.10.13.1

**Added:** Initial release. Read-only CloudFormation failure diagnostics:
`list_stacks`, `describe_stack`, `list_stack_events` (failed events,
root-cause candidates, rollback blockers, nested-stack follow), and
`lookup_events` (CloudTrail LookupEvents with principal extraction and an error
roll-up).
