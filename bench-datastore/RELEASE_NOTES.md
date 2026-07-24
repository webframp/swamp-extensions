## 2026.07.24.1

**Added:** Initial release of the datastore benchmarking harness.

- Two workflow-based scenarios: throughput (breadth) and write-stress (depth)
- Zero lock contention by construction — each worker owns isolated models
- Backend-agnostic measurement of datastore I/O independent of swamp core
  locking
- Configurable at runtime via workflow inputs (scenario, worker count, duration
  controlled by caller)
- Deployable on ECS Fargate or runnable locally

**Fixed:** Payload delivery uses stdin streaming instead of CLI arguments to
avoid Linux MAX_ARG_STRLEN (131072 bytes) limit on large (500KB) write-stress
payloads.

**Fixed:** Probe measurements in workflows are scoped to the worker's own model
to prevent cross-worker data inflation under concurrent load.
