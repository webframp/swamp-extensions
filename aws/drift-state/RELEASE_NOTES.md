## 2026.06.27.1

**Added:** Initial release of `@webframp/aws/drift-state` — unified drift
detection model that composes observations from adopt, inventory, and terraform
models into queryable versioned state.

Methods: `compute_drift`, `set_baseline`, `get_drifted`, `get_drift_timeline`,
`get_drift_velocity`, `refresh`.

Includes companion workflow `@webframp/drift-state-refresh` for automated
upstream sync + drift computation.
