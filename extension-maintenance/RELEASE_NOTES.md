## 2026.09.24.1

**Fixed:** Audit no longer plans npm or JSR versions newer than Deno's minimum
dependency age. It reports the newest release published at least
`min_dependency_age_hours` ago (new global argument, default 24). Before, the
2026-09-24 sweep pinned `@aws-sdk/*` 3.1140.0 hours after release;
`swamp extension quality` rejected it in CI across 21 extensions. A pin newer
than that version is no longer reported as stale, and unpublished or deprecated
npm versions are never picked. Manifest pins compare numerically too, so audit
never plans a downgrade.

**Fixed:** `apply-bump` appends upgrade entries correctly to compact
`upgrades: [{ ... }, { ... }]` arrays. The old splice landed inside the last
element and produced a syntax error. Comments and strings no longer steer the
insert, and an insert that would not parse is reported and never written.

**Changed:** `apply-bump` fails after writing `current-apply` when any extension
recorded an error, including a failed `deno.lock` regeneration. It used to
succeed, so the sweep workflow reported success over half-written lockfiles. The
workflow's `verify` step still runs afterwards to snapshot the repo.

**Changed:** `quality-gate` fails an extension that misses CI's quality verdict
(status `passed`, 100%, `allPassed` not false). It used to record the score
only.

**Changed:** Local `deno cache` and `deno task` runs ignore the minimum
dependency age (`--minimum-dependency-age=0`, `NPM_CONFIG_MIN_RELEASE_AGE=0`).
The gate's `swamp extension quality` check still enforces it, matching CI.

**Upgrade note:** The only new global argument, `min_dependency_age_hours`, has
a default, so existing instances need no change. The model has no `upgrades:`
array, so no migration entry is required.
