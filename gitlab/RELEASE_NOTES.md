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
