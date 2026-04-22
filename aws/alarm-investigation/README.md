# @webframp/aws/alarm-investigation

CloudWatch alarm investigation and triage model for swamp. This extension
enriches CloudWatch alarms with metric activity, SNS subscription data,
state-change history, and a verdict that classifies each alarm as one of:
**healthy**, **stale**, **silent**, **noisy**, **orphaned**, or **unknown**.

## Installation

```bash
swamp extension pull @webframp/aws/alarm-investigation
```

## Authentication

Uses the default AWS credential chain (environment variables, shared config,
instance profiles, ECS task roles). No credentials are stored in swamp.

### Required IAM Permissions

```json
{
  "Effect": "Allow",
  "Action": [
    "cloudwatch:DescribeAlarms",
    "cloudwatch:DescribeAlarmHistory",
    "cloudwatch:GetMetricStatistics",
    "sns:ListSubscriptionsByTopic"
  ],
  "Resource": "*"
}
```

## Methods

### investigate

Deep-dive enrichment for a single alarm by name. Fetches metric activity for the
last 24 hours, state-change history for the last 7 days, and SNS topic
subscription counts. Assigns a verdict and writes one `alarm_detail` resource.

```bash
swamp model method run <name> investigate alarmName="MyAlarm"
```

### triage

Fan-out enrichment across all (or filtered) alarms in the account. Writes one
`alarm_detail` resource per alarm plus a `triage_summary` resource with
aggregate verdict and state counts.

```bash
swamp model method run <name> triage
swamp model method run <name> triage stateFilter=ALARM limit=50
```

## Verdict Classifications

| Verdict   | Condition                                              |
|-----------|--------------------------------------------------------|
| orphaned  | INSUFFICIENT_DATA for more than 365 days               |
| silent    | In ALARM with no alarm actions configured              |
| stale     | In ALARM for more than 180 days                        |
| noisy     | More than 5 state changes in the last 7 days           |
| healthy   | OK, has actions, and has recent metric data points     |
| unknown   | None of the above patterns matched                     |

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
