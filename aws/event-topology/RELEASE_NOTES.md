## 2026.07.13.1

**Changed:** Upgraded the AWS SDK v3 client pins from `3.821.0` to `3.1069.0`
(eventbridge, sns, sqs, lambda, sts, credential-providers), bringing this
extension in line with the rest of the repo's AWS models.

**Fixed:** The per-topic SNS subscription listing and the Lambda event-source
mapping listing paginated with no upper bound. Both now stop after a defensive
`MAX_PAGES` (50) ceiling and log a warning, preventing an unbounded discovery
loop on pathological accounts. Rule/topic/queue listings were already bounded by
their `max*` arguments and are unchanged.
