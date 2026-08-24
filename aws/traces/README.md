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
swamp extension pull @webframp/aws/traces
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

| Method              | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `get_service_graph` | Retrieve the X-Ray service dependency graph with health statistics |
| `get_traces`        | List trace summaries with optional filter expressions              |
| `get_errors`        | Fetch error, fault, or throttle traces for incident investigation  |
| `analyze_errors`    | Aggregate error patterns and surface top faulty services and URLs  |

## Resources

- **service_graph** -- Service dependency graph with edge statistics (30 min
  lifetime)
- **trace_summaries** -- Paginated trace summary list (1 hr lifetime)
- **error_analysis** -- Aggregated error rates and top offenders (1 hr lifetime)

## Time Formats

The `startTime` and `endTime` parameters accept relative durations (`30m`, `1h`,
`2d`) and ISO 8601 timestamps (`2026-03-30T12:00:00Z`).

## Troubleshooting

### Empty results or zero traces returned

X-Ray is regional. The default region is `us-east-1`; if your services run
elsewhere, pass `--global-arg region=<your-region>` when creating the model
instance. Zero traces can also mean no instrumented traffic occurred in the
requested time window.

### Invalid `startTime` silently returns one hour of data

The `parseRelativeTime` helper accepts `30m`, `1h`, `2d` (digits followed by
`m`, `h`, or `d`) and ISO 8601 timestamps. Any value that matches neither format
silently falls back to "1 hour ago." If your time window looks wrong, check for
typos — a string like `"1x"` or `"2hrs"` will not error but will quietly use a
one-hour lookback.

### Results are truncated at 20 pages

All methods except `analyze_errors` cap pagination at `MAX_PAGES = 20`. If the
`truncated` field in the output resource is `true`, narrow your time window or
add a filter expression to reduce the result set. The `analyze_errors` method
lacks this cap but terminates at 1,000 traces.

### `get_traces` returns fewer results than `limit`

The `limit` parameter (default 100, max 1000) controls the target count, but
pagination may stop early if the `MAX_PAGES` cap is reached first. Set a
narrower `startTime` rather than raising `limit` past the point where 20 pages
of results can satisfy the request.

### Authentication failures

When `profile` is set, credentials resolve via `fromIni({ profile })`, which
supports SSO token cache. If your SSO session is expired, re-authenticate with
`aws sso login --profile <profile>` before running methods. When `profile` is
omitted, the default credential chain applies (environment variables, shared
credentials file, instance metadata).

## License

Apache-2.0
