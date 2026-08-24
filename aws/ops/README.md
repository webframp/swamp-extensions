# @webframp/aws-ops

AWS Operations Toolkit -- unified incident investigation and operational
visibility for AWS environments. This extension bundles a workflow and a report
that together gather observability data from CloudWatch Logs, Metrics, Alarms,
X-Ray Traces, EC2/Lambda inventory, and networking resources, then produce an
actionable incident report.

## Prerequisites

The workflow depends on six model extensions. Install them and create instances
before running the investigation:

```bash
swamp extension pull @webframp/aws-ops

swamp model create @webframp/aws/logs       aws-logs       --global-arg region=us-east-1
swamp model create @webframp/aws/metrics    aws-metrics    --global-arg region=us-east-1
swamp model create @webframp/aws/alarms     aws-alarms     --global-arg region=us-east-1
swamp model create @webframp/aws/traces     aws-traces     --global-arg region=us-east-1
swamp model create @webframp/aws/inventory  aws-inventory  --global-arg region=us-east-1
swamp model create @webframp/aws/networking aws-networking --global-arg region=us-east-1
```

## Usage

Run the investigate-outage workflow to collect data and generate the report:

```bash
swamp workflow run @webframp/investigate-outage
```

The workflow executes the following steps in parallel where possible:

1. Gather alarm summary and active alarms.
2. Analyze Lambda Duration/Errors and ELB 5XX/latency metrics for anomalies.
3. Retrieve the X-Ray service dependency graph and error traces.
4. List CloudWatch log groups and search for error patterns.
5. Inventory EC2 instances and Lambda functions.
6. List load balancers and NAT gateways with health status.
7. Generate an incident report that summarizes all findings.

## Report Output

The `@webframp/incident-report` report produces both Markdown and structured
JSON output containing:

- Alarm status and recent state changes
- Metric anomaly highlights (Lambda and ELB)
- Trace error analysis with top faulty services
- Infrastructure inventory (EC2, Lambda)
- Networking status (load balancers, NAT gateways)
- Actionable recommendations

## Required IAM Permissions

At minimum the calling identity needs:

- `logs:DescribeLogGroups`, `logs:StartQuery`, `logs:GetQueryResults`,
  `logs:FilterLogEvents`
- `cloudwatch:ListMetrics`, `cloudwatch:GetMetricStatistics`,
  `cloudwatch:GetMetricData`
- `cloudwatch:DescribeAlarms`, `cloudwatch:DescribeAlarmHistory`
- `xray:GetServiceGraph`, `xray:GetTraceSummaries`
- `ec2:DescribeInstances`, `lambda:ListFunctions`
- `elasticloadbalancing:DescribeLoadBalancers`, `ec2:DescribeNatGateways`

## Troubleshooting

### Report shows "No data available" for every section

Both workflows mark all steps as `allowFailure: true`. If every dependency model
fails (credentials, permissions, wrong region), the workflow still "succeeds"
and the report renders with placeholder text in each section. Check
`swamp run history` to identify which steps failed and why.

### `investigate-outage` workflow `--input region=...` has no effect

The workflow declares a `region` input but no step references it. The actual
region is baked into the dependency model instances at creation time
(`--global-arg region=us-east-1`). To target a different region, recreate the
model instances.

### `morning-pulse` workflow is undocumented

The extension ships two workflows: `investigate-outage` (documented above) and
`morning-pulse` (fleet health overview). The morning-pulse workflow requires
additional model instances not listed in the Prerequisites section:
`aws-alarms-{region}`, `alarm-investigation-{region}`, `aws-costs` (from
`@webframp/aws/cost-explorer`), and `github` (from `@webframp/github`).

### Display limits truncate report content

The incident report slices output for readability: alarm state changes (10),
active alarms (10), anomalies (5), top faulty services/URLs (5), and non-running
EC2 instances (10). These are report display limits, not API fetch limits. The
underlying data may contain more entries than shown.

### Profile configuration not documented

Pass `--global-arg profile=<name>` when creating dependency model instances for
SSO or named-profile credential resolution. The README only lists IAM
permissions without guidance on profile configuration.

## License

Apache-2.0 -- see [LICENSE.md](LICENSE.md).
