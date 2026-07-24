## 2026.07.24.1

**Added:** Initial release of the datastore benchmarking harness.

- Two workflow-based scenarios: throughput (breadth) and write-stress (depth)
- Zero lock contention by construction — each worker owns isolated models
- Backend-agnostic measurement of datastore I/O independent of swamp core
  locking
- Configurable at runtime via workflow inputs (scenario, worker count, duration
  controlled by caller)
- Deployable on ECS Fargate or runnable locally
- Payload delivery uses stdin streaming via temp files to avoid Linux
  MAX_ARG_STRLEN (131072 bytes) limit on large (500KB) write-stress payloads
- Probe measurements in workflows are scoped to the worker's harness model via
  `--model` filter to prevent cross-worker data inflation under concurrent load
- `payload_size` accepted as an optional workflow input on bench-write-stress
  for controlled single-size runs
