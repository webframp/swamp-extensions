# @webframp/extension-maintenance

Extension repository maintenance model for swamp. Observes a multi-extension
repo, audits dependency freshness, plans version bumps, and applies changes with
human approval.

Replaces the manual audit → bump → test → PR loop with typed, observable methods
that produce versioned data at each step.

## Methods

### `audit`

Pure observation. Scans all extensions in the repo, queries npm and the swamp
registry for latest versions, computes quality scores. Produces a structured
staleness report.

```bash
swamp model method run ext-maint audit
swamp model method run ext-maint audit --input filter=aws/
```

### `plan-bump`

Reads the latest audit output and produces a structured change plan: which files
to modify, what version strings change, draft release notes. No side effects.

```bash
swamp model method run ext-maint plan-bump
swamp model method run ext-maint plan-bump --input skip_testing=true
```

### `apply-bump`

Executes the latest plan. Writes version changes, updates manifests, creates
RELEASE_NOTES.md files. Supports `dry_run` mode.

```bash
# Preview what would change
swamp model method run ext-maint apply-bump --input dry_run=true

# Apply for real
swamp model method run ext-maint apply-bump
```

### `quality-gate`

Runs the full local validation suite across all (or filtered) extensions:
`deno task check`, `lint`, `fmt`, `test`, plus `swamp extension quality` and
`swamp extension fmt --check`.

```bash
swamp model method run ext-maint quality-gate
swamp model method run ext-maint quality-gate --input filter=cloudflare
swamp model method run ext-maint quality-gate --input stop_on_failure=true
```

## Setup

```bash
swamp extension pull @webframp/extension-maintenance

# Create a maintainer instance for your repo
swamp model create @webframp/extension-maintenance/maintainer ext-maint \
  --global-arg repo_root=/path/to/your/extension-repo
```

## Workflow

```bash
# 1. Observe — what's stale?
swamp model method run ext-maint audit

# 2. Plan — what would we change?
swamp model method run ext-maint plan-bump

# 3. Review the plan output (human decision point)

# 4. Apply — write the changes
swamp model method run ext-maint apply-bump

# 5. Verify — run quality gates
swamp model method run ext-maint quality-gate

# 6. Commit and PR (external to this model)
```

## Troubleshooting

### `plan-bump` throws "No audit data found"

Run the `audit` method first. The plan reads the `current-audit` resource and
throws if it is missing. The audit → plan → apply sequence is strict.

### `apply-bump` throws "No plan found"

Run `plan-bump` first (and approve the workflow step if running via the
workflow). The apply reads the `current-plan` resource.

### Registry unavailability produces false "not stale" results

If npm or JSR registries are unreachable during audit, the `npmEligible()` and
`jsrEligible()` helpers return `null`. The audit then compares the current
version against itself, reporting zero staleness. Re-run audit when registry
connectivity is restored.

### Per-extension apply failures fail the method after the loop

If one extension fails during `apply-bump` (a file write error, an upgrade entry
that would leave the source unparseable, a broken upgrade chain, or a failed
`deno.lock` regeneration), the error is recorded in the `errors` array and the
loop continues with the remaining extensions. Once every entry has been
attempted, `current-apply` is written and the method fails, so the sweep
workflow run is marked failed. The `verify` step still runs (it depends on
`apply` with `always`) to snapshot what state the repo is in. Check
`current-apply` for per-extension details. An upgrade entry that would not parse
is never written; the file is left as it was.

### Audit plans only versions older than Deno's minimum dependency age

Deno refuses npm and JSR versions published less than 24 hours ago by default.
`swamp extension quality`, which CI runs on every changed extension, resolves
dependencies without the lockfile and has no per-extension override, so a
fresher pin fails CI. Audit therefore reports as `latest` the newest release
published at least `min_dependency_age_hours` ago (default 24). For fast-moving
packages such as `@aws-sdk/*` that means a sweep lands one daily release behind.
`--global-arg min_dependency_age_hours=0` plans the newest release regardless of
age.

Local `deno cache` and `deno task` runs inside `apply-bump` and `quality-gate`
ignore the age rule, since audit already bounds it. The gate's
`swamp extension quality` check does not, so that check fails locally exactly
when CI would.

### `registry_timeout` global arg for slow registries

The default registry query timeout is 30 seconds. If you hit timeouts against a
slow npm mirror, increase it: `--global-arg registry_timeout=60`.

### Quality gate requires CI's quality verdict

Each extension must score what CI's quality job requires: status `passed`, 100%,
and `allPassed` not false. A lower score is listed in that extension's errors
and counts as a failure.

### Quality gate runs `deno task fmt`, not `fmt:check`

The quality-gate method invokes `deno task fmt` which may modify files as a side
effect. Ensure your working tree is clean before running the quality gate
standalone.

## Development

```bash
cd extension-maintenance
deno task check
deno task lint
deno task fmt
deno task test
```
