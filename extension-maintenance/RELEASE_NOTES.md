## 2026.07.25.1

**Added:** Initial release of the extension maintenance model.

- `audit` method: scans all extensions, queries npm/JSR/swamp registries for
  latest versions, produces structured staleness report with quality scores
- `plan-bump` method: reads audit output, computes structured change plan with
  CalVer versioning and draft release notes
- `apply-bump` method: executes the plan, writes version changes and
  RELEASE_NOTES.md files (supports dry_run mode)
- `quality-gate` method: runs deno check/lint/fmt/test plus swamp extension
  quality and fmt across all or filtered extensions
