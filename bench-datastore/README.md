# @webframp/bench-datastore

Datastore benchmarking harness for swamp. Two workflow-based test scenarios
that exercise any swamp datastore backend under sustained load without lock
contention.

Designed for ECS Fargate deployment but works locally for quick validation.

## Architecture

**One harness instance per worker.** Each worker creates its own model
instances (`bench-harness-w001`, `bench-probe-w001`, `bench-w001-m001` through
`bench-w001-m050`). Workers never share models — zero lock contention by
construction, not by luck.

## Scenarios

### A: Throughput (breadth)

Each worker owns 50 `command/shell` models. A workflow cycle performs
write → read → health-check, measuring per-step latency.

- 10 workers × 50 models each = 500 models (completely disjoint)
- Rotates through operations per iteration
- Measures: sync push/pull speed, data search, datastore latency

### B: Write Stress (depth)

Each worker owns 1 model, writes continuously with rotating payload sizes.
A workflow performs write → verify, measuring sustained single-writer throughput.

- 10 workers × 1 model each = 10 models (completely disjoint)
- Payload rotation: small (100B) → medium (10KB) → large (500KB+)
- Large payloads exercise chunked storage (>256KB default)
- Measures: writes/sec, chunk handling, version accumulation

## Setup

```bash
swamp extension pull @webframp/bench-datastore

# For each worker (e.g., worker 1):
# Create the harness instance for this worker
swamp model create @webframp/bench-datastore/harness bench-harness-w001 \
  --global scenario=throughput --global worker_id=1 --global models_per_worker=50

# Run setup to create worker-owned models
swamp model method run bench-harness-w001 setup
```

## Running

### Scenario A — single iteration

```bash
swamp workflow run @webframp/bench-throughput-cycle \
  --input harness_model=bench-harness-w001 \
  --input probe_model=bench-probe-w001 \
  --input iteration=1
```

### Scenario B — single iteration

```bash
swamp workflow run @webframp/bench-write-stress \
  --input harness_model=bench-harness-w001 \
  --input probe_model=bench-probe-w001 \
  --input iteration=1 \
  --input payload_size=medium
```

### Loop (local)

```bash
HARNESS="bench-harness-w001"
PROBE="bench-probe-w001"
for i in $(seq 1 1000); do
  swamp workflow run @webframp/bench-throughput-cycle \
    --input harness_model=$HARNESS \
    --input probe_model=$PROBE \
    --input iteration=$i
done
```

### ECS Fargate deployment

Each Fargate task gets a `WORKER_ID` environment variable. The entrypoint
script:
1. Creates the harness instance with `worker_id=$WORKER_ID`
2. Runs setup
3. Loops calling `swamp workflow run` with incrementing iteration

## Results

Each iteration produces a `result` resource with timing data:

```json
{
  "scenario": "throughput",
  "workerId": 1,
  "iteration": 42,
  "operation": "write-small",
  "modelName": "bench-w001-m042",
  "durationMs": 1847,
  "success": true
}
```

Resource instance names include the worker ID (`w1-iter-42`), so results
from multiple workers never collide.

## Design Principles

- **Zero lock contention**: each worker owns disjoint models
- **One harness per worker**: no shared state between workers
- **Workflow-native**: every operation is a workflow step with built-in timing
- **Backend-agnostic**: measures the datastore, not swamp core lock behavior
- **Composable**: run one or both scenarios, vary worker count at deploy time
- **Observable**: all timing data stored as swamp resources, queryable via CEL

## Development

```bash
cd bench-datastore
~/.swamp/deno/deno task check
~/.swamp/deno/deno task test
```
