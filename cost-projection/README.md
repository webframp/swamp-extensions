# @webframp/cost-projection

GPU inference cost projection across cloud, rental, and capex scenarios.

## Problem

Organizations evaluating self-hosted GPU inference need to compare
fundamentally different cost structures — committed cloud reservations, hourly
GPU rentals, and capital hardware purchases — using the same unit. This
extension normalizes all scenarios to $/GPU-hour for apples-to-apples
comparison.

## Model Types

| Type | Domain | Key Inputs |
|------|--------|------------|
| `gpu-cloud` | Hyperscaler instances (AWS, Azure, GCP) | Instance rate, capacity model, utilization, replicas |
| `gpu-rental` | Third-party providers (CoreWeave, Lambda, RunPod) | Per-GPU-hour rate, commitment discount |
| `gpu-capex` | On-prem / colo hardware | Hardware cost, useful life, facility, staff, maintenance |

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

# Compare all recorded scenarios
swamp report run @webframp/cost-projection-comparison
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

`webframp/cost-projection-comparison` — workspace-scoped report that queries all
cost-projection model instances and produces a ranked comparison table with
crossover analysis.

## License

Apache-2.0
