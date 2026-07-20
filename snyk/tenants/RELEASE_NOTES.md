## 2026.07.20.1

**Fixed:** Org-scoped methods (paths under `/orgs/{org_id}/...`) dropped their
`org_id` path parameter. The generated code referenced `args.org_id`, but the
argument was never declared or forwarded, so requests went to
`/orgs/undefined/...` and returned HTTP 404. These methods now declare and
forward `org_id` correctly.

**Upgrade note:** Org-scoped methods now take a required `org_id` argument.
Calls that previously failed with a 404 succeed once `org_id` is supplied.
