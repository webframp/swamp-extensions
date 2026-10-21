## 2026.10.21.2

**Changed:** The remaining numeric ID arguments now reject a value that is not a
positive integer, such as `0`, `-3` or `1.5`, at input validation, before any
request reaches GitLab. Previously these values were sent to GitLab as-is, and
on a REST path such as `/jobs/1.5` GitLab could read a fractional ID as a
different object. Affected arguments:

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

**Changed:** `milestone` on `create_issue` and `update_issue` rejects a numeric
ID that is not a positive integer, and a string of only zeros (`"0"`), which
used to be sent as milestone ID 0. Titles are unaffected, including ones that
look like numbers, such as `"1.5"`.

**Upgrade note:** No globalArguments change. Resource schemas are unchanged.
