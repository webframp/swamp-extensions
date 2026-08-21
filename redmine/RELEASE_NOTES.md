## 2026.08.21.1

### Added

- Retroactive compatibility note for the `list_issues` resource instance-name
  change introduced in `2026.08.10.1`.

### Upgrade note (retroactive — applies to 2026.08.10.1)

**Breaking change to `list_issues` data-resource instance names.**

Prior to `2026.08.10.1`, `list_issues` wrote its data resource under the
constant instance name `all`. Starting with `2026.08.10.1` (PR #343 — make
project global arg optional), the instance name is derived from active filters
using a prefixed scheme to avoid collisions between hyphenated project
identifiers and downstream field values:

| Filter combination | Old instance name | New instance name |
|--------------------|-------------------|-------------------|
| No filters | `all` | `all` (unchanged) |
| `project` only | `all` | `p:<project>` |
| `project` + `parentId` | `all` | `p:<project>-parent:<parentId>` |
| `project` + `assignedToId` | `all` | `p:<project>-a:<assignedToId>` |

The table shows representative examples. All active filter arguments
contribute segments in the order: `p:`, `a:`, `s:`, `t:`, `parent:`.

**Impact:** Any `data.query` expression or workflow step that references the
`list_issues` resource by its old instance name will fail with an index-out-of-bounds
error after upgrading past `2026.08.10.1`.

**Recommended consumer pattern:** Within workflows, prefer filtering on
`workflowRunId` rather than `name` when querying `list_issues` output. The
`workflowRunId` predicate is stable across filter and naming changes:

```cel
data.query("tracker", "issues", workflowRunId == run.id)
```

## 2026.08.20.1

**Upgrade note:** Bumped zod from 4.3.6 to 4.4.3. No behavioral changes — dependency version alignment only.
