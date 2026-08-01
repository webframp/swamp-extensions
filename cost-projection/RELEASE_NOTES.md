# Release Notes

## 2026.08.01.1

**Fixed:** Report name now uses collective prefix (`@webframp/cost-projection-comparison`).
Previous name (`webframp/cost-projection-comparison`) failed publish validation.

## 2026.07.31.1

Initial release.

- Three model types: `gpu-cloud`, `gpu-rental`, `gpu-capex`
- All normalize to $/GPU-hour for cross-scenario comparison
- Capex model includes sensitivity analysis (utilization × useful-life matrix)
- Workspace-scoped comparison report with crossover analysis
- Single-currency assumption (all scenarios must share a currency)
- Optional per-token break-even calculation against API pricing
