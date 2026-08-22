## 2026.08.21.2

**Changed:** CloudWatch Metrics API failures now say which metric or function
was being queried instead of surfacing the raw SDK error. `ListMetrics`,
`GetMetricStatistics` (in `get_data`, `analyze`, and `get_ec2_cpu`), and
`GetMetricData` (in `get_lambda_metrics`) failures all raise a clear error
naming the namespace/metric name, EC2 instance ID, or Lambda function name
involved, with the original SDK error preserved as the cause.

No schema changes.

## 2026.08.21.1

**Changed:** Tightened `namespace`, `metricName`, `instanceId`, and `functionName`
arguments across `get_data`, `analyze`, `get_ec2_cpu`, and `get_lambda_metrics` to
require non-empty strings — these are required identifiers the CloudWatch API
already rejects when empty.
