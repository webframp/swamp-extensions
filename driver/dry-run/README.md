# @webframp/dry-run

A dry-run execution driver for [swamp](https://github.com/systeminit/swamp). This driver captures the full method execution request without running it, returning the request envelope as a pending resource for inspection. It serves as a safe, side-effect-free tool for debugging workflows, auditing method arguments, and validating pipeline configuration before hitting real APIs.

## Installation

Register the extension in your swamp workspace:

```bash
swamp extension install @webframp/dry-run
```

## Usage

Configure the dry-run driver in your workflow or invoke it directly to capture what a method execution would look like without performing any real work.

```yaml
# workflow.yaml — use dry-run to preview an AWS inventory call
jobs:
  preview:
    driver: "@webframp/dry-run"
    steps:
      - method: describe_instances
        model: "@webframp/aws/inventory"
        args:
          region: us-east-1
```

The driver produces a single `pending` output named `dry-run-<methodName>` containing a JSON capture of the full request envelope:

```json
{
  "capturedAt": "2026-04-22T12:00:00.000Z",
  "driver": "@webframp/dry-run",
  "protocolVersion": 1,
  "modelType": "@webframp/aws/inventory",
  "methodName": "describe_instances",
  "globalArgs": { "region": "us-east-1" },
  "methodArgs": { "filters": [] },
  "hasBundle": false,
  "bundleSize": 0
}
```

## How It Works

1. The driver receives the standard execution request (model type, method name, arguments, optional bundle, resource specs, file specs, and trace headers).
2. It logs each section of the request for visibility.
3. It serializes the full request into a JSON capture object and returns it as a `pending` resource output with status `success`.

No network calls, no file writes, no side effects.

## Running Tests

```bash
cd driver/dry-run
deno task test
```

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) for details.
