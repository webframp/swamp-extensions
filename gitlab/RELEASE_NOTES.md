## 2026.10.15.1

**Added:** `remove_work_item_parent` and `convert_work_item_type`, using the
work-item GraphQL API (`workItemUpdate` hierarchy widget, `workItemConvert`)
that the REST issues API lacks. Removing a parent leaves a work item with no
ancestor; converting a Task to an Issue makes it show on issue boards. Type
names resolve case-insensitively against the project's work item types. Both
are no-ops when the work item is already in the requested state. Results
land in the new `workItemParent` and `workItemType` resources. No
globalArguments change.

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
