# @webframp/aws/metrics

A swamp extension for querying and analyzing AWS CloudWatch Metrics. This model
provides operational visibility into CloudWatch metric namespaces, enabling
performance monitoring, trend analysis, and anomaly detection across AWS services.

## Features

- List available CloudWatch metrics by namespace
- Retrieve metric data points with configurable statistics and time ranges
- Analyze metrics for trends, anomalies, and summary statistics using linear regression
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
swamp extension install @webframp/aws/metrics
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

## License

Apache-2.0
