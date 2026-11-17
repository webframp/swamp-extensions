## 2026.11.17.1

**Fixed:** `retry_pipeline` was a silent no-op when the only failure sat in a
downstream (child or grandchild) pipeline: it reported `succeeded` while
nothing re-ran. It now walks the pipeline's bridge jobs recursively (up to 50
downstream pipelines), retries the failed jobs in each, and fails with an
error when no pipeline in the chain has a failed job. Allowed-to-fail jobs are
skipped. A failed root bridge's old downstream jobs may re-run alongside the
re-triggered pipeline. A failed root bridge still triggers
the pipeline retry.

**Added:** `retryResult` carries optional `retriedJobIds` (new ids of the
downstream jobs re-run), `failedRetries` (steps that failed), and `truncated`
(a list page or the 50-pipeline cap left part of the chain unvisited; run the
method again). If any retry step fails, the result is still written and the
method then errors listing the failures.

**Changed:** `retry_pipeline` now makes extra read calls (jobs and bridges per
pipeline), and a pipeline with no failed jobs now errors instead of returning
GitLab's retry response.

**Upgrade note:** No required schema changes; the new field is optional. The
model version moves to 2026.11.17.1 with an identity upgrade.
