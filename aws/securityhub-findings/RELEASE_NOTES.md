## 2026.10.06.1

**Changed:** Workflow step names are now kebab-case (`severity-summary`, `critical-findings`, `high-findings`, `diff-findings`, `by-type`) instead of snake_case, following the direction of swamp-club lab #3060. The triage report matches both forms, so runs recorded before this version still render.

**Upgrade note:** In a future version the report will be updated to use only the new kebab-case step names, and runs recorded with the old snake_case names will no longer be picked up. Re-run the workflow to produce data under the new names.

## 2026.09.24.1

**Changed:** Bump @aws-sdk/* 3.1133.0 → 3.1139.0 (3 packages)

## 2026.09.18.1

**Upgrade note:** Normalized `npm:zod` dependency version to 4.6.5 across the
repo. No behavioral changes in this extension.
