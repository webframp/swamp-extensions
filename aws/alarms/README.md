# @webframp/aws/alarms

Query and analyze AWS CloudWatch Alarms for operational visibility and incident response. This extension provides methods to list alarms, retrieve alarm history, identify active alerts, and generate summaries of alarm states across your AWS account.

## Authentication

This extension uses the default AWS credential chain. Ensure your environment has valid AWS credentials configured (environment variables, shared credentials file, or IAM role).

### Required IAM Permissions

- `cloudwatch:DescribeAlarms`
- `cloudwatch:DescribeAlarmHistory`

## Installation

```bash
swamp extension install @webframp/aws/alarms
```

## Usage

Create a model instance and run methods against it:

```bash
# Create an alarms model instance targeting us-east-1
swamp model create @webframp/aws/alarms aws-alarms --global-arg region=us-east-1

# List all alarms
swamp model method run aws-alarms list_alarms

# List only alarms in ALARM state
swamp model method run aws-alarms list_alarms --input stateValue=ALARM

# Get active alarms (convenience shortcut)
swamp model method run aws-alarms get_active

# Get alarm history for the last 24 hours
swamp model method run aws-alarms get_history --input startTime=24h

# Get history for a specific alarm over the past 7 days
swamp model method run aws-alarms get_history --input alarmName=my-alarm --input startTime=7d

# Get a summary with state counts and recent changes from the past 6 hours
swamp model method run aws-alarms get_summary --input historyHours=6
```

## Methods

| Method | Description |
|---|---|
| `list_alarms` | List CloudWatch alarms with optional state and name prefix filters |
| `get_active` | Get all alarms currently in ALARM state |
| `get_history` | Get alarm state change history with time range filters |
| `get_summary` | Get a summary including state counts and recent state changes |

## Time Formats

The `startTime` and `endTime` parameters accept relative times and ISO 8601 dates:

```text
30m    -- 30 minutes ago
1h     -- 1 hour ago
2d     -- 2 days ago
2026-03-30T12:00:00Z  -- absolute ISO 8601 timestamp
```

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for details.
