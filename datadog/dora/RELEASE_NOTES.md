## 2026.08.21.1

**Changed:** Schema-only tightening pass, no behavioral change.
- Added `.min(1)` to `apiKey` and `appKey` in the global arguments, and to
  `deployment_id`/`failure_id` in the delete, get, and patch method
  arguments, so empty identifiers are rejected before making an API call.
- Added `.describe()` to previously undocumented fields: the JSON:API
  `type` field on the deployment/failure creation resource schemas, the
  nested `git.commit_sha`/`git.repository_id`/`git.repository_url` fields,
  and the `custom_tags`/`git`/`remediation` arguments on the
  `create_dora_deployment`, `create_dora_failure`, and
  `patch_dora_deployment` methods.
