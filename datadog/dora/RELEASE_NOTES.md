## 2026.10.07.1

**Added:** `patch_dora_deployment_by_version` marks a deployment as failed by
service, env, and version (`PATCH /api/v2/dora/deployments`), with a matching
`patch_dora_deployment_by_version` resource.

**Fixed:** The shared API helper no longer throws on a successful response with
an empty body (such as 202 Accepted); it returns an empty result. Datadog
answers the by-version patch with an empty 202, which the previous helper failed
to parse. Paginated list requests tolerate an empty page body the same way. A
body that is not valid JSON now fails with an error naming the HTTP method,
path, and status, with a snippet of the body.

**Changed:** The description of `patch_dora_deployment` now reads "Mark a
deployment as failed by ID" (previously "Patch a deployment event"). Behavior is
unchanged.

**Upgrade note:** Additive changes only; existing stored resources remain valid
and no migration is needed.
