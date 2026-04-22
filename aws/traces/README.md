# @webframp/aws/traces

AWS X-Ray Traces model for swamp. Query and analyze distributed traces for
incident investigation, performance analysis, and service dependency mapping.

This extension wraps the AWS X-Ray API to retrieve service graphs, trace
summaries, and error analytics. It supports relative time expressions, X-Ray
filter expressions, and automatic pagination so you can explore trace data
without writing SDK boilerplate.

## Prerequisites

- AWS credentials configured via the default credential chain
- IAM permissions: `xray:GetServiceGraph`, `xray:GetTraceSummaries`

## Installation

```bash
swamp extension install @webframp/aws/traces
```

## Quick Start

Create a model instance and start querying traces:

```bash
# Create a traces model targeting us-east-1
swamp model create @webframp/aws/traces aws-traces \
  --global-arg region=us-east-1

# Retrieve the service dependency graph for the last hour
swamp model method run aws-traces get_service_graph --input startTime=1h

# Search for traces with a filter expression
swamp model method run aws-traces get_traces \
  --input startTime=1h \
  --input 'filterExpression=service("api") AND http.status = 500'

# Get fault traces for incident triage
swamp model method run aws-traces get_errors --input errorType=fault

# Analyze error patterns over the last six hours
swamp model method run aws-traces analyze_errors --input startTime=6h
```

## Methods

| Method | Description |
|---|---|
| `get_service_graph` | Retrieve the X-Ray service dependency graph with health statistics |
| `get_traces` | List trace summaries with optional filter expressions |
| `get_errors` | Fetch error, fault, or throttle traces for incident investigation |
| `analyze_errors` | Aggregate error patterns and surface top faulty services and URLs |

## Resources

- **service_graph** -- Service dependency graph with edge statistics (30 min lifetime)
- **trace_summaries** -- Paginated trace summary list (1 hr lifetime)
- **error_analysis** -- Aggregated error rates and top offenders (1 hr lifetime)

## Time Formats

The `startTime` and `endTime` parameters accept relative durations (`30m`,
`1h`, `2d`) and ISO 8601 timestamps (`2026-03-30T12:00:00Z`).

## License

Apache-2.0
