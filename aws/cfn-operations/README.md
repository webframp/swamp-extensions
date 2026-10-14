# @webframp/aws/cfn-operations

Mutating CloudFormation recovery operations. The read-only investigation
methods live in `@webframp/aws/cfn-diagnostics`; this extension holds the calls
that change a stack, so the diagnostics extension can stay safe to run with a
read-only profile.

## continue_update_rollback

Resumes a stack stuck in `UPDATE_ROLLBACK_FAILED`. It refuses any other status
before sending anything, submits `ContinueUpdateRollback`, and polls until the
rollback leaves its in-progress states or `waitSeconds` passes (default 300).

```bash
swamp model create @webframp/aws/cfn-operations cfn-ops \
  --global-arg region=us-east-1 --global-arg profile=my-account/Administrator

swamp model method run cfn-ops continue_update_rollback \
  --input stackName=my-app
```

If the rollback cannot restore a resource, name it in `resourcesToSkip`.
Skipped resources stay in whatever state they are in:

```bash
swamp model method run cfn-ops continue_update_rollback \
  --input stackName=my-app --input 'resourcesToSkip=["Db"]'
```

## Result

The `rollback_result` data records `statusBefore`, `statusAfter`,
`statusReason`, `settled` and `succeeded`. A rollback that fails again is
recorded with its status reason, not raised as an error, so check `succeeded`.
When it is false, find the next blocker with `list_stack_events` and
`lookup_events` in `@webframp/aws/cfn-diagnostics` before retrying.

Run it with a profile that is allowed to update the stack. CloudFormation
performs the rollback with the caller's credentials unless the stack has a
service role.
