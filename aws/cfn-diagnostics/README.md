# @webframp/aws/cfn-diagnostics

A swamp extension model for investigating failed or rolled-back CloudFormation
stack operations. It reads stack event history and CloudTrail, and answers the
questions an operator asks first: which resource failed, why, which failure is
the root cause rather than a cascade, which resources blocked rollback, and
which principal was denied which API call.

## Features

- **Root-cause extraction** -- failed events are split into root-cause
  candidates, cascades (cancellations, a stack's own status row,
  "following resource(s) failed" wrappers), and rollback blockers (failures
  after the stack began rolling back). A `DELETE_FAILED` on a plain stack delete
  has no rollback in its operation, so it is a root cause, not a blocker
- **Per-operation grouping** -- `operations` groups events by stack and
  operation, so a retry's failures are not mixed with an earlier attempt's
- **Nested stacks** -- follows `AWS::CloudFormation::Stack` resources at every
  level, breadth-first (bounded at 25 stacks in total), and merges their events
  into one deduplicated, time-ordered timeline. A nested stack that cannot be
  read is recorded under `nestedErrors` and sets `truncated`
- **CloudTrail correlation** -- `lookup_events` returns the calling principal,
  session issuer, `invokedBy` service, error code and message, rolled up by
  error and API
- **Honest truncation** -- every paginated read is bounded and reports
  `truncated` when more data may exist
- **Relative or ISO times** -- `30m`, `6h`, `2d`, or `2026-10-09T18:00:00Z`

## Prerequisites

This extension uses the default AWS credential chain, or the optional `profile`
global argument. The IAM principal needs read-only access:

- `cloudformation:ListStacks`
- `cloudformation:DescribeStacks`
- `cloudformation:DescribeStackEvents`
- `cloudformation:ListStackResources`
- `cloudtrail:LookupEvents`

## Usage

```bash
swamp extension pull @webframp/aws/cfn-diagnostics

swamp model create @webframp/aws/cfn-diagnostics cfn-prod \
  --global-arg region=us-east-1 --global-arg profile=prod-account

# Find the stack
swamp model method run cfn-prod list_stacks --input nameContains=my-app

# Failed events, root-cause candidates and rollback blockers
swamp model method run cfn-prod list_stack_events \
  --input stackName=my-app --input since=7d

# Current state of every resource, plus parameters and tags
swamp model method run cfn-prod describe_stack --input stackName=my-app

# The denied API call behind a failure
swamp model method run cfn-prod lookup_events \
  --input startTime=2026-10-09T18:00:00Z \
  --input endTime=2026-10-09T18:15:00Z \
  --input lookupAttribute=EventSource --input lookupValue=rds.amazonaws.com
```

Read results with CEL or `swamp data query`:

```bash
swamp data query 'model("cfn-prod") && name == "events-my-app"' --select content
```

## Methods

| Method | Purpose | Resource written |
| ------ | ------- | ---------------- |
| `list_stacks` | List stacks, filtered by name substring and status | `stack_list` (`instanceName`, default `stack-list`) |
| `describe_stack` | Status, parameters, tags, resource states | `stack_detail` (`detail-<stack name>`) |
| `list_stack_events` | Events in a window with failures extracted | `stack_events` (`events-<stack name>`) |
| `lookup_events` | CloudTrail events with error roll-up | `trail_events` (`instanceName`, default `trail-lookup`) |

## Limits and caveats

- **`lookup_events` covers management events for the last 90 days** and
  supports one server-side filter. `errorsOnly` and `eventSource` are applied
  client-side after fetching, so a narrow window or a server-side filter keeps
  the scan small. Scans are bounded at 20 pages (1,000 events) and `truncated`
  is set when the cap is hit. Requests are paced under the 2 req/s API limit.
- **Calls rejected before authentication do not appear in CloudTrail.** An
  `The security token included in the request is invalid` stack event has no
  CloudTrail counterpart.
- **Deleted stacks must be addressed by full stack ARN.** `stackStatus` is
  `null` when CloudFormation reports the stack as not found, and
  `stackStatusError` is set for any other `DescribeStacks` failure. A stack
  addressed by name or by ARN is stored under the same `events-<stack name>`
  data name, so querying a deleted stack by ARN overwrites an earlier record for
  a live stack of the same name.
- **`list_stacks` hides `DELETE_COMPLETE` stacks by default** (CloudFormation
  keeps them for 90 days and they can crowd out live stacks under the page
  cap). Set `includeDeleted=true` or pass `statuses`. The name filter is
  client-side, so `truncated` can hide matches on a very large account.
- **Root-cause classification is heuristic.** It reads each stack's own status
  rows and the failure text. A failure after the stack began rolling back, in
  the same operation, is a cleanup blocker; so is one inside a nested stack
  during its parent's rollback. An operation with no `*_ROLLBACK_*` row is
  treated as not rolled back (including stacks created with rollback disabled,
  where every failure reads as a root cause). Events with no operation token are
  split into operations at each new top-level `*_IN_PROGRESS` row. Edge cases:
  a second, independent failure that lands just after the rollback row looks
  like a blocker (it is still listed under `rollbackFailedEvents`), and a window
  that starts after the rollback row makes a blocker look like a root cause.
  A nested stack recreated under a different parent within the window is
  attributed to the last parent seen. Treat `rootCauseCandidates` as the place
  to start, not a verdict.
- **Time arguments** accept `30m`/`6h`/`2d` or an ISO 8601 date/time; anything
  else (including bare numbers) is rejected.
- **User-chosen names** (`instanceName`) accept letters, digits, `.`, `_` and
  `-`, and reject `latest` (reserved by swamp) and the `events-`/`detail-`
  prefixes used for generated names.
- Every request has a 30s deadline. If a later `lookup_events` page fails (for
  example throttling), earlier pages are kept, `truncated` is set, and the error
  is in `partialError`.
- **NoEcho parameters** are returned masked (`****`) by CloudFormation.
