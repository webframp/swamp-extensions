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
  --global repo_root=/path/to/your/extension-repo
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

## Development

```bash
cd extension-maintenance
deno task check
deno task lint
deno task fmt
deno task test
```
