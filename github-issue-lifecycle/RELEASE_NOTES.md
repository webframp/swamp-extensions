## 2026.08.21.1

**Changed:** Added `.describe()` documentation to previously undocumented fields
across the resource schemas (`ContextSchema`, `ClassificationSchema`,
`PlanSchema`, `PullRequestSchema`) and method argument schemas (`triage`,
`plan`, `iterate`, `approve`, `pr_merged`, `pr_failed`, `close`, `status`). No
behavioral change.

## 2026.08.15.1

**Fixed:** Every method that reads lifecycle state (`start`, `triage`, `plan`,
`iterate`, `approve`, `implement`, `link_pr`, `pr_merged`, `pr_failed`,
`complete`, `close`) threw before reaching GitHub because it relied on
`ctx.storedResources`, a field current swamp no longer passes to model methods.
All state reads now go through `ctx.readResource()`, the supported API.

**Fixed:** Resource instance names collided across specs — `context`, `state`,
`classification`, and `pullRequest` all wrote to the same `issue-<n>` storage
path for a given issue, since instance names must be unique across all specs on
a model, not just within one. Each spec now writes to a spec-prefixed path
(`state-issue-42`, `pullRequest-issue-42`, etc.), so per-issue data no longer
overwrites itself across specs.

**Changed:** `pullRequest` gained a `retryCount` field, incremented on every
`pr_failed` call and carried forward through `link_pr` retries and `pr_merged`.
The `lifecycle-metrics` report now reads this field directly instead of relying
on raw stored-resource access (also removed) to derive retry counts from
historical writes.

**Upgrade note:** Existing `pullRequest` data written before this version lacks
`retryCount` and will read as `0` going forward — no migration needed. Issues
already tracked under the old `issue-<n>` instance naming will not be found by
the new spec-prefixed lookups; re-run `start` to re-establish state under the
new naming for any in-flight issues.
