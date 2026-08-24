# @webframp/cost-projection

GPU inference cost projection across cloud, rental, and capex scenarios.

## Problem

Organizations evaluating self-hosted GPU inference need to compare fundamentally
different cost structures — committed cloud reservations, hourly GPU rentals,
and capital hardware purchases — using the same unit. This extension normalizes
all scenarios to $/GPU-hour for apples-to-apples comparison.

## Model Types

| Type         | Domain                                            | Key Inputs                                               |
| ------------ | ------------------------------------------------- | -------------------------------------------------------- |
| `gpu-cloud`  | Hyperscaler instances (AWS, Azure, GCP)           | Instance rate, capacity model, utilization, replicas     |
| `gpu-rental` | Third-party providers (CoreWeave, Lambda, RunPod) | Per-GPU-hour rate, commitment discount                   |
| `gpu-capex`  | On-prem / colo hardware                           | Hardware cost, useful life, facility, staff, maintenance |

## Quick Start

```bash
swamp extension pull @webframp/cost-projection

# Record a cloud scenario
swamp model create @webframp/cost-projection/gpu-cloud my-cloud-scenario
swamp model method run my-cloud-scenario record \
  --input name=my-cloud-scenario \
  --input provider=aws \
  --input region=us-east-1 \
  --input instanceType=p5.48xlarge \
  --input gpuCount=8 \
  --input gpuModel="NVIDIA H100" \
  --input capacityModel=on-demand \
  --input instanceRatePerHour=98.32

# Record a second scenario for comparison
swamp model create @webframp/cost-projection/gpu-cloud my-capacity-block-scenario
swamp model method run my-capacity-block-scenario record \
  --input name=my-capacity-block-scenario \
  --input provider=aws \
  --input region=us-east-1 \
  --input instanceType=p5.48xlarge \
  --input gpuCount=8 \
  --input gpuModel="NVIDIA H100" \
  --input capacityModel=capacity-block \
  --input instanceRatePerHour=61.00

# The comparison report runs automatically after any method call on any
# gpu-cloud, gpu-rental, or gpu-capex instance. Retrieve its latest output:
swamp report get @webframp/cost-projection-comparison --model my-capacity-block-scenario --markdown
```

## Sensitivity Analysis (capex)

```bash
# Run across utilization × useful-life matrix
swamp model method run my-capex-scenario sensitivity \
  --input 'usefulLifeMonthsRange=[24,36,48,60]' \
  --input 'utilizationPctRange=[60,75,85,95]'
```

## Design Principles

- **No live API calls.** Rates are manually entered from quotes, pricing pages,
  or sales conversations. This keeps the extension portable and removes auth
  complexity.
- **Assumptions surfaced, not hidden.** Every input that drives the $/GPU-hour
  number is a named, versioned field. Disagreements become visible.
- **Single-currency comparison.** All scenarios must use the same currency.
  Convert before entering.
- **FOCUS-aligned capex semantics.** Capex amortization uses concepts from the
  FinOps Open Cost and Usage Specification for future interoperability.

## Methods

All models share: `record`, `project`, `update_rate` (or `update_hardware_cost`
for capex). The capex model adds `sensitivity` for multi-assumption analysis.

## Report

`@webframp/cost-projection-comparison` — model-scoped report attached by default
to `gpu-cloud`, `gpu-rental`, and `gpu-capex`. It runs automatically after any
method call on any instance of the three types, scans every cost-projection
instance in the repo, and produces a ranked comparison table with crossover
analysis. Retrieve it with
`swamp report get @webframp/cost-projection-comparison --model <any-instance>`.

## Troubleshooting

### "No scenario recorded — run record first" error

The `project`, `update_rate`, `update_hardware_cost`, and `sensitivity` methods
all require a stored scenario resource from a prior `record` invocation. Run
`record` first with your scenario parameters.

### Sensitivity requires array inputs

The `sensitivity` method takes range arrays (e.g., `usefulLifeMonthsRange`,
`utilizationRange`). These must be passed as JSON arrays via `--input`. If the
CLI does not parse bracket syntax, use `--input-file` with a JSON payload.

### Break-even fields only computed when comparison rate is provided

The `project` method computes `breakEvenTokensPerMonth` and
`breakEvenRequestsPerMonth` only when `apiComparisonRatePerMToken` is present in
the scenario. Without it, these fields are omitted from the projection.

### Three independent models for different acquisition strategies

Each model (`gpu-cloud`, `gpu-rental`, `gpu-capex`) has its own schema and
scenario resource. They do not share state. The `scenario_comparison` report
reads from all three to produce a comparative view.

## License

Apache-2.0
