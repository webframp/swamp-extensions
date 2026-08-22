## 2026.08.21.1

**Changed:** Error messages from `discover` now say which AWS call failed and
with what identifier, instead of surfacing the raw SDK error. Failures listing
EventBridge buses/rules/targets, SNS topics/subscriptions, SQS queues, or
Lambda event source mappings now name the operation, the resource (bus name,
rule name, topic ARN), and the region, with the original SDK error preserved
as the cause.

Resolving the caller's account ID via STS now raises a clear error naming the
region if `GetCallerIdentity` fails, instead of an unannotated SDK exception.

`analyze` used to log an error and silently return zero results when called
with `query=path` and no `nodeId`, or when no graph had been discovered yet,
or when the given `nodeId` didn't exist in the stored graph — callers had no
signal that anything went wrong. All three cases now throw a descriptive
error explaining what was missing and how to fix it (e.g. "run discover
first" or "nodeId not found in the stored topology graph").

No schema changes.
