# @webframp/aws/logs

A swamp extension model for querying and analyzing AWS CloudWatch Logs. This
extension provides operational visibility and incident investigation capabilities
by wrapping the CloudWatch Logs API with structured methods for log group
discovery, Logs Insights queries, error pattern analysis, and recent event
filtering.

## Features

- **Log group discovery** -- list and filter CloudWatch log groups by prefix
- **Logs Insights queries** -- run ad-hoc CloudWatch Logs Insights queries with automatic polling for results
- **Error pattern analysis** -- detect and aggregate error patterns across log groups using configurable keywords
- **Recent event filtering** -- retrieve recent log events with CloudWatch filter patterns
- **Relative time parsing** -- specify time ranges as relative offsets (`1h`, `30m`, `2d`) or ISO 8601 timestamps

## Prerequisites

This extension uses the default AWS credential chain. The IAM principal must
have the following permissions:

- `logs:DescribeLogGroups`
- `logs:StartQuery`
- `logs:GetQueryResults`
- `logs:FilterLogEvents`

## Installation

```bash
swamp extension install @webframp/aws/logs
```

## Usage

Create a model instance scoped to a specific AWS region, then invoke its
methods to interact with CloudWatch Logs.

```bash
# Create a logs model instance
swamp model create @webframp/aws/logs aws-logs --global-arg region=us-east-1

# List log groups filtered by prefix
swamp model method run aws-logs list_log_groups --input prefix=/aws/lambda

# Run a Logs Insights query
swamp model method run aws-logs query \
  --input 'logGroupNames=["/aws/lambda/my-function"]' \
  --input 'queryString=fields @timestamp, @message | filter @message like /error/i | limit 50' \
  --input startTime=1h

# Find error patterns in the last two hours
swamp model method run aws-logs find_errors \
  --input 'logGroupNames=["/aws/lambda/my-function"]' \
  --input startTime=2h

# Get recent events with a filter pattern
swamp model method run aws-logs get_recent_events \
  --input logGroupName=/aws/lambda/my-function \
  --input filterPattern=ERROR
```

## Methods

| Method              | Description                                          |
|---------------------|------------------------------------------------------|
| `list_log_groups`   | Discover CloudWatch log groups by name prefix        |
| `query`             | Run CloudWatch Logs Insights queries                 |
| `find_errors`       | Analyze error patterns with keyword detection        |
| `get_recent_events` | Filter and retrieve recent log events                |

## Time Formats

The `startTime` and `endTime` parameters accept two formats:

```text
Relative:  30m, 1h, 2d   (minutes, hours, days ago from now)
Absolute:  2026-03-30T12:00:00Z   (ISO 8601)
```

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for details.
