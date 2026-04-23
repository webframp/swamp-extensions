---
name: pr-workflow
description: End-to-end PR workflow for swamp extension development — branch, develop, push, respond to adversarial review, iterate until CI passes, then merge. Use when creating features, fixes, or any change that needs to land on main. Triggers on "open a PR", "push this up", "submit for review", "fix the review", "merge this", "PR workflow", "adversarial review".
metadata:
  version: 2026-04-23
---

# PR Workflow

End-to-end pull request workflow for swamp extension changes. Covers branching,
development, CI, adversarial code review response, and merge.

## Overview

Every change follows this loop:

```
branch → develop → push → PR → CI + adversarial review → fix → push → repeat → merge
```

The adversarial review is an automated Claude-based reviewer that runs on every
push to a PR. It files a `CHANGES_REQUESTED` review with numbered findings if it
finds issues, or `APPROVED` if clean. CI also runs deno check/lint/fmt/test for
affected extensions.

## Step 1: Branch

Always branch from an up-to-date main:

```bash
cd ~/src/webframp/swamp-extensions
git checkout main && git pull origin main
git checkout -b feat/my-feature   # or fix/, docs/, chore/, test/
```

## Step 2: Develop

Follow the guidance in `CLAUDE.md` for code style, testing, and manifest
conventions. Key points:

- Run `deno task check && deno task lint && deno task fmt && deno task test`
  locally in the extension directory before committing
- For workflows: use `swamp workflow create <name> --json` to scaffold (never
  generate UUIDs), then edit the YAML, then `swamp workflow validate`
- For reports: `deno check`, `deno lint`, `deno fmt --check` on the report file
- Bump `version` in `manifest.yaml` (CalVer `YYYY.MM.DD.N`) in the same PR
- Use [Conventional Commits](https://www.conventionalcommits.org/) scoped to
  the extension

## Step 3: Push and Open PR

Stage specific files (avoid `git add .`):

```bash
git add <specific files>
git commit -m "feat(aws/my-ext): add the thing"
git push -u origin feat/my-feature
gh pr create --title "feat(aws/my-ext): add the thing" --body "..."
```

PR description should include:
- Summary of what changed and why
- Example usage (commands to install, create models, run)
- Files changed
- What was tested locally

## Step 4: Respond to Adversarial Review

The adversarial review runs automatically on each push. It produces a review
comment with findings categorized as Critical/High, Medium, and Low.

### Reading the review

```bash
# View the review comments
gh pr view <number> --comments --json comments,reviews

# Or view in browser
gh pr view <number> --web
```

### Fixing findings

Work through findings by severity — Critical/High first, then Medium, then Low:

1. **Read each finding carefully** — the review includes file:line references,
   a breaking scenario, and usually a suggested fix
2. **Fix the code** — address the root cause, not just the symptom
3. **Run local checks** before pushing:
   ```bash
   cd <extension-dir>
   deno task check && deno task lint && deno task fmt && deno task test
   # For workflows:
   swamp workflow validate <name> --json
   ```
4. **Commit with a descriptive message** referencing what was fixed:
   ```bash
   git add <specific files>
   git commit -m "fix(aws/my-ext): address adversarial review findings

   1. Fix X — description
   2. Fix Y — description"
   ```
5. **Push** — this triggers a new CI + adversarial review run:
   ```bash
   git push
   ```

### Common adversarial review patterns

| Finding pattern | Typical fix |
|----------------|-------------|
| `null.method()` TypeError | Use `typeof x === "type"` or `x != null` (loose equality) instead of `!== undefined` |
| Path traversal | Normalize path and assert it stays under the expected prefix |
| Markdown injection | Escape `\|`, backticks, `*`, `_` in values interpolated into tables/lists |
| Unchecked cast (`as`) crash | Guard with `in` check or `typeof` before casting |
| Silent error swallowing | Log or surface the error, don't just `catch {}` |
| Missing `allowFailure` handling | Ensure report code handles absent data from failed steps |
| Partial failure crash | Initialize accumulators before conditional blocks that populate them |

### Iteration

The review re-runs on every push. Stale `CHANGES_REQUESTED` reviews are
automatically dismissed when a new review runs. Keep pushing fixes until the
review comes back as `APPROVED` (verdict: PASS).

Check CI status between pushes:

```bash
gh pr checks <number>
```

## Step 5: Merge

Once CI passes and the adversarial review approves, merge with a slash command
comment on the PR:

```bash
gh pr comment <number> --body "/shipit"
```

This triggers the merge workflow which:
- Verifies CI has passed
- Squash-merges the PR
- Deletes the branch
- CI runs again on main, then auto-publishes any extensions with bumped versions

Alternative merge commands: `/lgtm`, `/approve`

## Quick Reference

| Task | Command |
|------|---------|
| Create branch | `git checkout -b feat/name` |
| Local checks | `deno task check && deno task lint && deno task fmt && deno task test` |
| Validate workflow | `swamp workflow validate <name> --json` |
| Open PR | `gh pr create --title "..." --body "..."` |
| View review | `gh pr view <n> --comments --json comments,reviews` |
| Check CI status | `gh pr checks <n>` |
| Push fixes | `git push` (triggers new review) |
| Merge | `gh pr comment <n> --body "/shipit"` |

## Anti-patterns

- **Don't force-push** over review comments — push additional commits
- **Don't skip local checks** — CI takes minutes; `deno task` takes seconds
- **Don't fix only the symptom** — if the review says "null dereference", fix
  the root cause (missing guard), not just the one line
- **Don't ignore Low findings** — they're low severity, not no severity. Fix
  them while you're in the code
- **Don't bump versions in separate commits** — version bump goes in the same
  PR as the code change
