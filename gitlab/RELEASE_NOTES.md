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
