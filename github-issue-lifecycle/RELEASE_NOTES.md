## 2026.07.24.1

**Added:** Initial release of the GitHub issue lifecycle tracker.

- 12 methods covering the full issue lifecycle: start, triage, plan, iterate,
  approve, implement, link_pr, pr_merged, pr_failed, complete, close, status
- State machine with enforced valid transitions
- Optional lifecycle comment posting to the GitHub issue thread
- Optional `lifecycle:<phase>` label sync on the issue
- All state stored as versioned swamp resources (state, context, classification,
  plan, pullRequest) — queryable via CEL
- PR number auto-extraction from URL
- Idempotent link_pr (safe to re-link after retry)
- Configurable via globalArgs: repo, postComments, syncLabels
