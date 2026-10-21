## 2026.10.21.1

**Added:** Two methods, `remove_work_item_parent` and
`convert_work_item_type`. They use the work-item GraphQL API
(`workItemUpdate` with the hierarchy widget, and `workItemConvert`), which
the REST issues API does not cover.

- `remove_work_item_parent` leaves a work item with no ancestor. It fails
  unless the mutation response confirms the parent is gone. If the token
  cannot read the parent, it fails before sending the mutation, since
  GitLab would refuse it. Requires GitLab 17.2 or later.
- `convert_work_item_type` changes a work item's type. Converting a Task to
  an Issue makes it show on issue boards. Type names match the project's
  work item types, ignoring case and surrounding whitespace. An unknown name
  fails with the list of available types. It fails if GitLab returns a type
  other than the one requested.

Neither method sends a mutation when the work item is already in the
requested state. Results land in the new `workItemParent` and
`workItemType` resources, under the data names
`<project>-work-item-<iid>-parent` and `-type`, with `/` in the project
path written as `~` (for example `group~proj-work-item-7-parent`). No globalArguments change.
Contributed by @zWaR (#500).

**Changed:** Every method that takes an `iid` or `iids` argument (27
methods) now rejects a value that is not a positive integer, such as `0`,
`-3` or `1.5`, at input validation. Before, such a value reached GitLab and
failed later with a vaguer "not found" or null-payload error, so no call that
used to succeed is affected. Resource schemas are unchanged.

## 2026.10.14.2

**Added:** `search` method wrapping the GitLab REST search API at instance,
group, or project level (`/search`, `/groups/:id/search`,
`/projects/:id/search`). Supports every REST scope (blobs, commits, issues,
merge_requests, milestones, notes, projects, snippet_titles, users,
wiki_blobs), plus `ref` (project only) and `state` (issues/merge_requests
only). Results land in the new `searchResults` resource, follow
`x-next-page` up to `limit` (max 1000), and set `truncated` when more exist.
Invalid combinations fail before any request: `ref` outside
blobs/commits/wiki_blobs, `state=merged` outside merge_requests, and queries
under 2 characters. No globalArguments change.

## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.10.07.1

**Fixed:** `get_pipeline_by_iid` failed with `Field 'webUrl' doesn't exist on
type 'Pipeline'` on GitLab instances whose GraphQL schema lacks that field.
Closes #476.

**Changed:** The query no longer requests `webUrl`. The `webUrl` in the
`pipelineByIid` resource is now built as
`https://<host>/<project>/-/pipelines/<id>`. No schema or `globalArguments`
change.
