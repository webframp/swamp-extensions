## 2026.07.20.1

**Fixed:** Group-scoped methods (paths under `/groups/{group_id}/...`) dropped
their `group_id` path parameter. The generated code referenced `args.group_id`,
but the argument was never declared or forwarded, so requests went to
`/groups/undefined/...` and returned HTTP 404. These methods now declare and
forward `group_id` correctly.

**Upgrade note:** Group-scoped methods now take a required `group_id` argument.
Calls that previously failed with a 404 succeed once `group_id` is supplied.
