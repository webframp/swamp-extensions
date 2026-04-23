# @webframp/aws/alarm-investigation

CloudWatch alarm investigation and triage model. Enriches alarms with metric activity, SNS subscription data, state-change history, and a verdict classifying each alarm as healthy, stale, silent, noisy, orphaned, or unknown.

## Authentication

Uses the default AWS credential chain. Ensure your environment has valid AWS credentials configured (environment variables, shared credentials file, or IAM role).

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

| Method | Description |
|---|---|
| `investigate` | Deep-dive enrichment for a single alarm by name |
| `triage` | Fan-out enrichment across all (or filtered) alarms in the account |

## Verdict Classifications

| Verdict | Condition |
|---|---|
| `orphaned` | INSUFFICIENT_DATA for > 365 days |
| `silent` | In ALARM with no alarm actions configured |
| `stale` | In ALARM for > 180 days |
| `noisy` | > 5 state changes in the last 7 days |
| `healthy` | OK, has actions, and has recent metric data points |
| `unknown` | None of the above patterns matched |

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for details.
