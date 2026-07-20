# @webframp/datadog/logs

Datadog Logs — submit log entries, run log analytics, and search logs from Swamp
workflows or ad-hoc model runs.

## Prerequisites

Configure the model with a Datadog API key, application key, and site before you
run any method:

- `apiKey`: Datadog API key (`DD-API-KEY`)
- `appKey`: Datadog application key (`DD-APPLICATION-KEY`)
- `site`: one of `us1`, `us3`, `us5`, `eu1`, `ap1`, or `us1-fed`

## Installation

```bash
swamp extension pull @webframp/datadog/logs
```

## Usage

Create a model instance and provide the required global arguments:

```bash
swamp model create @webframp/datadog/logs dd-logs \
  --global-arg apiKey=DD_API_KEY \
  --global-arg appKey=DD_APP_KEY \
  --global-arg site=us1
```

Each execution writes a Swamp resource describing the Datadog API response.

### Common methods

- `submit_log`: submit one or more log entries to Datadog.
- `aggregate_logs`: run a log analytics aggregate query.
- `list_logs_get`: search logs with a GET request and query parameters.
- `list_logs`: search logs with a POST request and a request body.

Example log submission:

```bash
swamp model run dd-logs submit_log \
  --arg entries='[{"message":"hello from swamp","ddsource":"swamp"}]'
```

## Development

```bash
cd ../../datadog/logs
deno task check
deno task lint
deno task fmt
deno task test
```

## License

Apache-2.0 — see [LICENSE.md](LICENSE.md).
