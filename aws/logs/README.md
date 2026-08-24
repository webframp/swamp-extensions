# @webframp/aws/logs

A swamp extension model for querying and analyzing AWS CloudWatch Logs. This
extension provides operational visibility and incident investigation
capabilities by wrapping the CloudWatch Logs API with structured methods for log
group discovery, Logs Insights queries, error pattern analysis, and recent event
filtering.

## Features

- **Log group discovery** -- list and filter CloudWatch log groups by prefix
- **Logs Insights queries** -- run ad-hoc CloudWatch Logs Insights queries with
  automatic polling for results
- **Error pattern analysis** -- detect and aggregate error patterns across log
  groups using configurable keywords
- **Recent event filtering** -- retrieve recent log events with CloudWatch
  filter patterns
- **Relative time parsing** -- specify time ranges as relative offsets (`1h`,
  `30m`, `2d`) or ISO 8601 timestamps

## Prerequisites

This extension uses the default AWS credential chain. The IAM principal must
have the following permissions:

- `logs:DescribeLogGroups`
- `logs:StartQuery`
- `logs:GetQueryResults`
- `logs:FilterLogEvents`

## Installation

```bash
swamp extension pull @webframp/aws/logs
```

## Usage

Create a model instance scoped to a specific AWS region, then invoke its methods
to interact with CloudWatch Logs.

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

| Method              | Description                                   |
| ------------------- | --------------------------------------------- |
| `list_log_groups`   | Discover CloudWatch log groups by name prefix |
| `query`             | Run CloudWatch Logs Insights queries          |
| `find_errors`       | Analyze error patterns with keyword detection |
| `get_recent_events` | Filter and retrieve recent log events         |

## Time Formats

The `startTime` and `endTime` parameters accept two formats:

```text
Relative:  30m, 1h, 2d   (minutes, hours, days ago from now)
Absolute:  2026-03-30T12:00:00Z   (ISO 8601)
```

## Troubleshooting

### Query times out with "Query did not complete within N seconds"

The `query` and `find_errors` methods poll `GetQueryResults` until the query
reaches `Complete` status. If the query exceeds `maxWaitSeconds` (default 60),
the method throws a timeout error and attempts a best-effort `StopQuery`. Large
time windows or unindexed log groups can trigger this. Narrow the time range,
reduce the number of log groups, or increase `--input maxWaitSeconds=120`.

### Invalid `startTime` silently defaults to one hour ago

The time parser accepts digits followed by `m`, `h`, or `d` (e.g. `30m`, `2h`,
`7d`) and ISO 8601 timestamps. Any value that matches neither format falls back
to "1 hour ago" without error. A typo like `"2hrs"` or `"1w"` will not fail — it
quietly applies the one-hour default.

### Empty `list_log_groups` results

CloudWatch log groups are regional. The default region is `us-east-1`. If your
log groups exist in another region, recreate the model instance with
`--global-arg region=<your-region>`. The optional `prefix` filter is
case-sensitive and matches from the beginning of the log group name.

### `find_errors` returns no matches despite errors in the logs

The method searches for configurable keywords (default includes `ERROR`,
`Exception`, `FATAL`, `CRITICAL`, and others). If your application uses
non-standard error markers, pass them via `--input 'keywords=["FAIL","crash"]'`.
The Logs Insights query generated internally uses case-sensitive matching.

### No pagination cap on `list_log_groups` or `get_recent_events`

Both methods paginate until the `limit` is satisfied or the API runs out of
results. Neither has a `MAX_PAGES` guard. Very high `limit` values can cause
many sequential API calls. Use the `prefix` or `filterPattern` arguments to
scope the request.

### `query` with `requireComplete=false` stores partial results

By default, the method waits for query completion. If you opt into
`requireComplete=false`, incomplete results are written to the resource without
error. The resource will reflect whatever data was available at timeout — check
the query status field to determine completeness.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for details.
