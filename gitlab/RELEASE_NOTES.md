## 2026.10.21.2

**Changed:** The remaining numeric ID arguments now reject a value that is not a
positive integer, such as `0`, `-3` or `1.5`, at input validation, before any
request reaches GitLab. Previously these values were sent to GitLab as-is, in
REST paths such as `/jobs/1.5`. Affected arguments:

- `noteId` on `update_issue_note`, `delete_issue_note`, `update_mr_note` and
  `delete_mr_note`
- `pipelineId` on `get_pipeline_jobs`, `retry_pipeline`, `cancel_pipeline` and
  `list_pipeline_bridges`
- `jobId` on `get_job_log` and `retry_job`
- `scheduleId` on `play_pipeline_schedule`
- `id` on `get_snippet`, `update_snippet` and `delete_snippet`

**Changed:** `get_job_log` `tailLines` must be an integer from 1 to 10000.
Before, `0` or a negative value was silently raised to 1, and any size was
accepted. The default stays 200.

**Changed:** `milestone` on `create_issue` rejects `0`, a string of only zeros
(`"0"`), and any number that is not a positive integer. These used to be sent to
GitLab as-is; milestone ID 0 names no milestone. On `update_issue`, `0` and
`"0"` still clear the issue's milestone, and other non-integer or negative
numbers are rejected. On both methods an empty string is now rejected at
validation; before, it was looked up as a title and failed with "no milestone
titled". Titles are unaffected, including ones that look like numbers, such as
`"1.5"`.

**Upgrade note:** No globalArguments change. Resource schemas are unchanged.
