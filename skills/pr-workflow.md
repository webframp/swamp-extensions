---
name: pr-workflow
description: End-to-end PR workflow for swamp extension development — branch, develop, then drive the rest (local adversarial review, push, CI watch, fix loop, merge) through the pr-factory software-factory instance. Use when creating features, fixes, or any change that needs to land on main. Triggers on "open a PR", "push this up", "submit for review", "fix the review", "merge this", "PR workflow", "adversarial review".
metadata:
  version: 2026-09-17
---

# PR Workflow

End-to-end pull request workflow for swamp extension changes. Branching and
development are ordinary agent work; everything from the first local review
onward is driven through a `@swamp/software-factory` instance
(`factory/pr-lifecycle.yaml` in this repo) so the ordering is enforced
structurally rather than remembered step-by-step.

## Overview

```
develop → local_review → push → ci_watch ─(green)→ merge → done
   ▲          ▲   │               │(red)
   │          │   └(rework)───────┼──────────┐
   │          │                   ▼          │
   │          └──────────── fix_ci ◄──────────┘
   └──────────────────────(rework)          (blocked)
```

The one rule this graph exists to enforce: a CI failure (`fix_ci`) can only
transition back to `local_review`, never straight to `push`. Every fix gets a
fresh adversarial review before the next push — the engine's gates refuse the
`push` transition otherwise, so this isn't something to remember anymore.

`swamp-extensions` ships extension source only and has no local swamp repo
state, so the live `pr-factory` model instance runs in a working swamp repo
(e.g. `~/src/disciplines/devsecops`), pointed at a checkout of this repo.
`factory/pr-lifecycle.yaml` here is the source of truth for the graph; the
working repo's instance is a copy of it, kept in sync by hand when the
definition changes.

## One-time setup (in the working swamp repo)

```bash
swamp extension pull @webframp/github          # watch_pr_checks, merge_pull_request
swamp extension pull @swamp/software-factory
swamp model create @swamp/software-factory pr-factory
swamp model edit pr-factory   # paste factory/pr-lifecycle.yaml's content under globalArguments
swamp model method run pr-factory validate      # confirm the graph compiles
```

## Step 1: Branch

Always branch from an up-to-date main:

```bash
cd ~/src/webframp/swamp-extensions
git checkout main && git pull origin main
git checkout -b feat/my-feature   # or fix/, docs/, chore/, test/
```

## Step 2: Develop (`develop` stage)

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

Start the run and record what you built:

```bash
swamp model method run pr-factory start --input workItem=feat/my-feature
swamp model method run pr-factory record_artifact --input workItem=feat/my-feature \
  --input name=change-summary \
  --input payload='{"summary":"...", "filesChanged":["..."]}'
swamp model method run pr-factory advance --input workItem=feat/my-feature --input transition=submit
```

## Step 3: Local review (`local_review` stage)

This stage dispatches the `pre-push-review` skill's methodology against
`git diff --staged` / `git diff origin/main...HEAD`, using the exact
adversarial-review prompt read live from `.github/workflows/ci.yml` (not a
hardcoded copy — see the stage's `systemPrompt` in `factory/pr-lifecycle.yaml`
for why). `status` tells you what to run and what to record:

```bash
swamp model method run pr-factory status --input workItem=feat/my-feature
# → dispatch the local_review work as described, then:
swamp model method run pr-factory record_artifact --input workItem=feat/my-feature \
  --input name=local-review --input payload='{"findings": [...]}'
swamp model method run pr-factory advance --input workItem=feat/my-feature --input transition=pass
# blocked with an actionable reason if findings aren't clear, or the review is stale
```

If the review finds CRITICAL/HIGH issues, `advance transition=rework` sends
you back to `develop` instead.

## Step 4: Push and open PR (`push` stage)

```bash
git add <specific files>
git commit -m "feat(aws/my-ext): add the thing"
git push -u origin feat/my-feature
gh pr create --title "feat(aws/my-ext): add the thing" --body "..."
```

Record the PR as evidence, then advance:

```bash
swamp model method run pr-factory record_evidence --input workItem=feat/my-feature \
  --input name=change-request \
  --input payload='{"repo":"webframp/swamp-extensions","number":<n>,"branch":"feat/my-feature","url":"https://github.com/..."}'
swamp model method run pr-factory advance --input workItem=feat/my-feature --input transition=submit
```

## Step 5: CI watch (`ci_watch` stage, zero-LLM)

This stage is a `work.mode: method` call to `@webframp/github`'s
`watch_pr_checks` — it bounded-polls `gh pr checks` to completion and records
the outcome. Run it, record the result, and advance along whichever
transition its gates satisfy:

```bash
swamp model method run pr-factory status --input workItem=feat/my-feature
# → run @webframp/github.watch_pr_checks with the bound inputs shown, then:
swamp model method run pr-factory record_evidence --input workItem=feat/my-feature \
  --input name=ci-result --input payload='{"status":"succeeded","runId":"<n>"}'
swamp model method run pr-factory advance --input workItem=feat/my-feature --input transition=green
# or transition=red, which routes to fix_ci
```

## Step 6: Fix loop (`fix_ci` stage, on red)

Read the CI failure, fix it, record a new `change-summary` version, and
submit — which routes back to `local_review`, not directly to `push`:

```bash
swamp model method run pr-factory record_artifact --input workItem=feat/my-feature \
  --input name=change-summary --input payload='{"summary":"fixed X"}'
swamp model method run pr-factory advance --input workItem=feat/my-feature --input transition=submit
```

### Common CI/review failure patterns

| Finding pattern | Typical fix |
|----------------|-------------|
| `null.method()` TypeError | Use `typeof x === "type"` or `x != null` (loose equality) instead of `!== undefined` |
| Path traversal | Normalize path and assert it stays under the expected prefix |
| Markdown injection | Escape `\|`, backticks, `*`, `_` in values interpolated into tables/lists |
| Unchecked cast (`as`) crash | Guard with `in` check or `typeof` before casting |
| Silent error swallowing | Log or surface the error, don't just `catch {}` |
| Missing `allowFailure` handling | Ensure report code handles absent data from failed steps |
| Partial failure crash | Initialize accumulators before conditional blocks that populate them |

## Step 7: Merge (`merge` stage, zero-LLM)

Once `ci_watch` is green, this stage is a `work.mode: method` call to
`@webframp/github`'s `merge_pull_request` — it posts `/shipit` and
bounded-polls `gh pr view` until the PR merges:

```bash
swamp model method run pr-factory status --input workItem=feat/my-feature
# → run @webframp/github.merge_pull_request with the bound inputs shown, then:
swamp model method run pr-factory record_evidence --input workItem=feat/my-feature \
  --input name=merge-result --input payload='{"status":"succeeded","runId":"<n>"}'
swamp model method run pr-factory advance --input workItem=feat/my-feature --input transition=done
```

A failed merge (conflict, blocked by branch protection) routes to `fix_ci` via
`transition=blocked` instead of `done`.

The merge workflow itself: verifies CI has passed, squash-merges the PR,
deletes the branch. CI runs again on main, then auto-publishes any extensions
with bumped versions.

## Inspecting a run

```bash
swamp model method run pr-factory summary --input workItem=feat/my-feature
swamp model method run pr-factory status --input workItem=feat/my-feature
swamp data query 'modelName == "pr-factory"' --select name   # what exists for this run
```

## Anti-patterns

- **Don't force-push** over review comments — push additional commits
- **Don't skip local checks** — CI takes minutes; `deno task` takes seconds
- **Don't fix only the symptom** — if the review says "null dereference", fix
  the root cause (missing guard), not just the one line
- **Don't ignore Low findings** — they're low severity, not no severity. Fix
  them while you're in the code
- **Don't bump versions in separate commits** — version bump goes in the same
  PR as the code change
- **Don't try to route `fix_ci` straight to `push`** — there's no such
  transition. If you find yourself wanting one, that's a sign to check
  whether `local_review`'s findings are actually clear first.
