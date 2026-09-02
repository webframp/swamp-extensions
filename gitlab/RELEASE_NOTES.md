## 2026.09.02.1

**Added:** `get_issue` method — fetches a single issue by `project` and `iid`,
including its `description` body, via GraphQL `project.issue(iid)`. Writes the
existing `issueDetail` resource (the same shape produced by `create_issue` and
`update_issue`). Enables reading full work-item details, such as a directly
addressed tier-1 to-do, without creating or mutating the issue.

**Fixed:** the `2026.07.30.1` upgrade erroneously injected `sourceBranch`,
`targetBranch`, and `webUrl` into `globalArguments` (only `host` and `token`
are valid), which broke **every** method on upgraded instances with an
`Unknown argument(s)` validation error. That upgrade is now a no-op on global
arguments (the `mergeStatus` fields it described belong to a resource schema,
which needs no attribute migration), and the `2026.09.02.1` upgrade removes the
stray keys from any instance already poisoned by it.

**Upgrade note:** running any method on an existing instance migrates it to
`2026.09.02.1` and strips the stray global-argument keys automatically. No
manual intervention is required.

## 2026.09.01.1

**Added:** `mergedAt` field on merge requests (GraphQL `mergedAt`, REST
`merged_at`) — the timestamp an MR was merged, or `null` if not merged.

**Added:** `approvers` field on merge requests — the usernames who approved
(reviewed) the MR, from GraphQL `approvedBy`. Enables cross-boundary review
attribution (an approver helps the MR author). REST-mapped MRs default to an
empty array.

**Added:** `list_commits` method — lists a project's commits (optionally a
branch, with a `since` lower time bound) via the REST `repository/commits`
endpoint, writing a `commits` resource. Enables commit-based contribution
analysis (who commits to another crew's repository).

Together these support downstream review-outcome / unblock-rate scoring and
cross-boundary contribution measurement.

**Upgrade note:** Purely additive and backward-compatible. New MR fields are
nullable / defaulted, so merge-request data stored by earlier versions still
validates on read. `list_commits` is a new method; no existing method changed.

## 2026.08.28.1

**Changed:** Normalized the extension license to Apache-2.0 and corrected the
copyright holder to "Sean Escriva". Extensions that previously shipped an MIT
LICENSE.md are now Apache-2.0, consistent with the repository root and every
other extension. No code or behavioral changes.

**Upgrade note:** License text only. No API, schema, or runtime behavior
changed.

## 2026.08.26.3

**Fixed:** Restored inline `npm:zod@4.4.3` import specifiers so the registry
quality scorer can resolve dependencies and score the extension. An earlier
release used a bare `"zod"` import-map specifier, which published but scored as
unscored.

**Changed:** Retained explicit `compilerOptions.strict` in `deno.json`. No
behavioral or schema changes.
