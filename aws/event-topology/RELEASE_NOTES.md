## 2026.07.18.2

**Added:** An `upgrades` array entry (no-op) to `event_topology.ts` for proper
`typeVersion` tracking on existing instances. No schema or behavior changes.

## 2026.07.18.1

**Changed:** Bumped `@aws-sdk/client-eventbridge`, `@aws-sdk/client-lambda`,
`@aws-sdk/client-sns`, `@aws-sdk/client-sqs`, `@aws-sdk/client-sts`, and
`@aws-sdk/credential-providers` from `3.1069.0` to `3.1090.0` for dependency
freshness. No behavior change.

## 2026.07.13.1

**Changed:** Upgraded the AWS SDK v3 client pins from `3.821.0` to `3.1069.0`
(eventbridge, sns, sqs, lambda, sts, credential-providers), bringing this
extension in line with the rest of the repo's AWS models.

**Fixed:** The per-topic SNS subscription listing and the Lambda event-source
mapping listing paginated with no upper bound. Both now stop after a defensive
`MAX_PAGES` (50) ceiling and log a warning, preventing an unbounded discovery
loop on pathological accounts. Rule/topic/queue listings were already bounded by
their `max*` arguments and are unchanged.

**Added:** A `truncated` boolean on the graph resource. It is set to `true`
whenever either pagination cap fires, so downstream consumers can distinguish an
incomplete graph from a complete one. The field defaults to `false`, so graphs
stored before this release still validate on read.
