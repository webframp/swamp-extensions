# @webframp/aws/alarm-investigation

CloudWatch alarm investigation and triage model. Enriches alarms with metric
activity, SNS subscription data, state-change history, and a verdict classifying
each alarm as healthy, stale, silent, noisy, orphaned, or unknown.

## Authentication

Uses the default AWS credential chain. Ensure your environment has valid AWS
credentials configured (environment variables, shared credentials file, or IAM
role).

For multi-account use, pass a shared-config profile explicitly instead of
relying on `AWS_PROFILE`:

```bash
swamp model create @webframp/aws/alarm-investigation alarm-inv \
  --global-arg region=us-east-1 --global-arg profile=prod-readonly
```

When `profile` is set, credentials resolve via `fromIni`, which also supports
the SSO token cache. Omit it to fall back to the default credential chain.

### Required IAM Permissions

- `cloudwatch:DescribeAlarms`
- `cloudwatch:DescribeAlarmHistory`
- `cloudwatch:GetMetricStatistics`
- `sns:ListSubscriptionsByTopic`

## Installation

```bash
swamp extension pull @webframp/aws/alarm-investigation
```

## Usage

```bash
# Create a model instance
swamp model create @webframp/aws/alarm-investigation alarm-inv \
  --global-arg region=us-east-1

# Investigate a single alarm
swamp model method run alarm-inv investigate --input alarmName="MyAlarm"

# Triage all alarms
swamp model method run alarm-inv triage

# Triage only alarms in ALARM state, limit to 50
swamp model method run alarm-inv triage --input stateFilter=ALARM --input limit=50
```

## Methods

| Method        | Description                                                       |
| ------------- | ----------------------------------------------------------------- |
| `investigate` | Deep-dive enrichment for a single alarm by exact name — writes one `alarm_detail` resource |
| `triage`      | Factory method: enriches all (or filtered) alarms in the account, writing one `alarm_detail` resource per alarm plus a `triage_summary` with verdict/state counts |

## Verdict Classifications

| Verdict    | Condition                                          |
| ---------- | -------------------------------------------------- |
| `orphaned` | INSUFFICIENT_DATA for > 365 days                   |
| `silent`   | In ALARM with no alarm actions configured          |
| `stale`    | In ALARM for > 180 days                            |
| `noisy`    | > 5 state changes in the last 7 days               |
| `healthy`  | OK, has actions, and has recent metric data points |
| `unknown`  | None of the above patterns matched                 |

## Troubleshooting

- **`investigate` throws `Alarm not found: "<name>" in region <region>`.**
  `DescribeAlarms` is scoped to the region in `globalArgs.region` (default
  `us-east-1`), and alarm names are matched exactly. If the alarm lives in a
  different region, or you passed a partial/mistyped name, `investigate`
  fails fast rather than returning an empty result — re-check both the name
  and the `--global-arg region=` value used when the model instance was
  created.

- **A triaged alarm shows `verdict: "unknown"` with `verdictReason: "Enrichment
  failed: ..."`.** `triage` catches per-alarm enrichment errors (in
  `enrichAlarm`) and writes a degraded placeholder record instead of failing
  the whole run — only a `logger.warn` marks it. Check the run's logs for the
  matching `Failed to enrich alarm` warning to see the underlying
  `DescribeAlarmHistory` (or other) error for that specific alarm.

- **`sns_topics` is `[]` with `subscriptionCount: 0` even though the alarm has
  alarm actions.** `resolveSnsTopics` silently swallows
  `ListSubscriptionsByTopic` errors — this happens when the SNS topic was
  deleted or the caller lacks `sns:ListSubscriptionsByTopic` on that topic.
  No warning is logged for this case, so a topic showing zero subscriptions
  is not proof the topic is unused; verify it directly with
  `aws sns get-topic-attributes` if precision matters.

- **`recentDataPoints` is `null` instead of a number.** `getRecentMetricStats`
  returns `null` whenever the alarm has no `Namespace`/`MetricName` (composite
  alarms) or when `GetMetricStatistics` itself errors (this happens for some
  anomaly-detection alarms) — both cases are swallowed without a log. A
  `null` here does not necessarily mean the metric is dead; cross-check with
  the CloudWatch console for composite or anomaly-detection alarms before
  trusting the `orphaned`/`stale` verdict.

- **`noisy` verdict caps out around 100 state changes.** `countRecentStateChanges`
  calls `DescribeAlarmHistory` with `MaxRecords: 100` and no pagination, so a
  genuinely flapping alarm with more than 100 `StateUpdate` events in the last
  7 days is still reported as exactly the API page size. The `verdictReason`
  appends `(capped at 100 per API page)` when the count is `>= 100` — treat
  that note as "at least this noisy," not an exact count.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for details.
