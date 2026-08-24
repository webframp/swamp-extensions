# @webframp/aws/metrics

A swamp extension for querying and analyzing AWS CloudWatch Metrics. This model
provides operational visibility into CloudWatch metric namespaces, enabling
performance monitoring, trend analysis, and anomaly detection across AWS
services.

## Features

- List available CloudWatch metrics by namespace
- Retrieve metric data points with configurable statistics and time ranges
- Analyze metrics for trends, anomalies, and summary statistics using linear
  regression
- Convenience methods for common use cases (EC2 CPU, Lambda function metrics)
- Automatic period calculation based on requested time range

## Authentication

Uses the default AWS credential chain. Ensure that the caller identity has the
following IAM permissions:

- `cloudwatch:ListMetrics`
- `cloudwatch:GetMetricStatistics`
- `cloudwatch:GetMetricData`

## Installation

```bash
swamp extension pull @webframp/aws/metrics
```

## Usage

Create a metrics model instance bound to a specific AWS region, then invoke any
of the available methods.

```bash
# Create the model instance
swamp model create @webframp/aws/metrics aws-metrics \
  --global-arg region=us-east-1

# List available metrics in a namespace
swamp model method run aws-metrics list_metrics \
  --input namespace=AWS/EC2

# Retrieve metric data with a specific statistic
swamp model method run aws-metrics get_data \
  --input namespace=AWS/EC2 \
  --input metricName=CPUUtilization \
  --input 'dimensions=[{"name":"InstanceId","value":"i-1234567890abcdef0"}]' \
  --input startTime=1h

# Analyze a metric for trends and anomalies
swamp model method run aws-metrics analyze \
  --input namespace=AWS/Lambda \
  --input metricName=Errors \
  --input 'dimensions=[{"name":"FunctionName","value":"my-function"}]' \
  --input startTime=6h
```

## Methods

| Method               | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `list_metrics`       | Discover available CloudWatch metrics by namespace       |
| `get_data`           | Retrieve metric data points with configurable statistics |
| `analyze`            | Analyze metrics for trends, anomalies, and summaries     |
| `get_ec2_cpu`        | Convenience method for EC2 CPU utilization               |
| `get_lambda_metrics` | Get key Lambda metrics (invocations, errors, duration)   |

## Time Formats

The `startTime` and `endTime` parameters accept relative durations or ISO 8601
timestamps:

```text
30m   - 30 minutes ago
1h    - 1 hour ago
2d    - 2 days ago
2026-03-30T12:00:00Z  - absolute ISO 8601 timestamp
```

## Troubleshooting

### Empty datapoints for a valid metric

CloudWatch retains data at different granularities based on age. Metrics older
than 15 days are available only at 1-hour resolution; older than 63 days only at
1-day resolution. If your requested period is finer than the available
resolution for the time range, the API returns zero datapoints. The extension
auto-calculates period from the time range, but an explicitly set `period` that
is too granular will produce empty results without error.

### `analyze` shows `trend: "insufficient_data"`

The trend calculation requires at least 3 datapoints. If your time window or
period produces fewer than 3 points, the trend field defaults to
`"insufficient_data"` and the summary statistics are all zero. Widen the time
range or reduce the period to get enough data points.

### Invalid `startTime` silently defaults to one hour ago

The time parser accepts digits followed by `m`, `h`, or `d` and ISO 8601
timestamps. Any value that matches neither format falls back to "1 hour ago"
without error. A string like `"1w"` or `"2hrs"` will not fail — it quietly
applies the one-hour default.

### `list_metrics` has no page-count cap

The method paginates until `limit` (default 100) is satisfied. There is no
`MAX_PAGES` guard, so a very high limit can cause many sequential API calls. The
API returns up to 500 metrics per page, so the default of 100 completes in a
single call. Increase cautiously.

### `get_lambda_metrics` data not in `datapoints` field

The Lambda convenience method stores its results in a non-schema `lambdaMetrics`
field rather than the standard `datapoints` array. When querying the resource,
look for `lambdaMetrics` in the output — the `datapoints` array will be empty.
This is a known schema quirk, not missing data.

### Region scope

CloudWatch Metrics are regional. The default is `us-east-1`. Pass
`--global-arg region=<your-region>` when creating the model instance. Pass
`--global-arg profile=<name>` for named-profile or SSO credential resolution.

## License

Apache-2.0
