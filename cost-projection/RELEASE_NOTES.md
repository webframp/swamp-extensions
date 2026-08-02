# Release Notes

## 2026.08.02.1

**Fixed:** The comparison report declared `scope: "workspace"`, which isn't a
valid `ReportScope` (`"method" | "model" | "workflow"`). The extension failed
to load entirely — `swamp doctor extensions` reported `ValidationFailed` for
`@webframp/cost-projection`, and the report could never run.

**Changed:** The report now runs at `model` scope and is attached as a
default report on `gpu-cloud`, `gpu-rental`, and `gpu-capex`, so it fires
after any method call on any instance of the three model types (including
`sensitivity` and `update_hardware_cost` on `gpu-capex`, which has no
`update_rate` method). Internally, `execute()` no longer relies on the single
instance's
`context.dataHandles` — it scans every cost-projection instance in the repo
via `dataRepository.findAllGlobal()`, so the table actually compares sibling
scenarios (e.g. an on-demand quote against a capacity-block quote) instead of
only ever showing the one instance that triggered the run.

**Upgrade note:** No input/output schema changes. Re-pull the extension to
pick up the fix — running any method on a `gpu-cloud`/`gpu-rental`/
`gpu-capex` instance now produces the cross-scenario table, retrievable with
`swamp report get @webframp/cost-projection-comparison --model <instance>`.

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
