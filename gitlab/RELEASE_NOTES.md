## 2026.09.20.1

**Added:** Ten new methods closing gaps reported in issue #420:

- `cancel_pipeline` — stop a pipeline that is still running (`retry_pipeline`
  only restarts one that's already finished).
- `get_pipeline_by_iid` — resolve a pipeline's global id from its
  project-scoped iid via GraphQL. `get_pipeline_jobs` and `retry_pipeline`
  need the global id; `list_pipelines` and the web UI only show the iid.
- `list_pipeline_bridges` — list a pipeline's trigger jobs and the downstream
  (child) pipelines they fan out to, which `get_pipeline_jobs` cannot see.
- `create_pipeline_schedule` — create a CI/CD pipeline schedule, including its
  variables sub-resource.
- `play_pipeline_schedule` — trigger a fresh pipeline carrying a schedule's
  CI/CD variables (pair with `get_pipeline_by_iid` to find the resulting
  pipeline, since GitLab returns 202 Accepted with no pipeline id).
- `create_branch` — create a branch (`list_branches` was read-only).
- `commit_file` — create or update a single file via a commit; falls back
  from a create action to an update action automatically when the file
  already exists.
- `list_repository_tree` — list a repository directory at a ref, following
  GitLab's `x-next-page` header across pages (capped at 20 pages) so a large
  directory is not silently cut off.
- `update_project_visibility` — change a project's visibility
  (`get_project_info` only reads it).
- `check_mr_merge_endpoint` — diagnostic: sends a non-mutating OPTIONS probe
  to an MR's merge endpoint and reports back the real Allow/Server/Via
  headers, to distinguish a proxy's 405 from GitLab's own.

**Changed:** `get_file` now also accepts a `project`/`filePath`/`ref` input
trio as an alternative to the existing blob `url` input — for callers that
already have those three values and shouldn't have to assemble a blob URL
just to have it parsed apart again. The existing size cap, credential
redaction, and binary-file rejection apply to both input paths. `fileContent`
output schema is unchanged.

**Upgrade note:** All additive — no `globalArguments` changes, no breaking
schema changes. Ten new resources were added (`pipelineCancel`,
`pipelineByIid`, `pipelineBridges`, `pipelineSchedule`,
`pipelineSchedulePlayResult`, `branchCreateResult`, `commitFileResult`,
`repositoryTree`, `projectVisibility`, `mrMergeEndpointCheck`).
