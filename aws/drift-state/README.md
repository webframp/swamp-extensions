# @webframp/aws/drift-state

Unified drift detection model that composes observations from existing models
(adopt, inventory, terraform) into queryable versioned state.

## Methods

- **compute_drift** — Compare latest upstream snapshots against baselines
- **set_baseline** — Mark current upstream state as expected
- **get_drifted** — Query resources currently in drifted state
- **get_drift_timeline** — History of drift events for a resource
- **get_drift_velocity** — Aggregate drift rate metrics
- **refresh** — Recompute drift from current upstream data

## Usage

```bash
swamp extension pull @webframp/aws/drift-state
swamp model create @webframp/aws/drift-state drift-state
swamp model method run drift-state set_baseline
swamp model method run drift-state compute_drift
swamp model method run drift-state get_drifted
```

## Workflow

```bash
swamp workflow run @webframp/drift-state-refresh
```
