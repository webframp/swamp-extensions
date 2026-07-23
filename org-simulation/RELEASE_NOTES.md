## 2026.07.23.1

**Added:** Initial release of `@webframp/org-simulation`, an agent-guided
organization design simulation model inspired by the Curious Duck simulation
studio (ducksimng.onrender.com).

- `design_topology` — capture an organization as a topology of teams,
  repos/modules, environments (with a defect/reliability model), and
  customer bases wired by connectors, under a named scenario label
  (`"current"` for as-is, or a descriptive label for a proposed redesign).
- `run_simulation` — run a deterministic, seedable flow simulation against a
  topology scenario, estimating feature/bug cycle times, defect detection and
  find-vs-fix balance, customer sentiment (NPS), and environment reliability
  over a configurable time horizon.
- `record_design_decision` — record an adopt/reject/iterate/hold decision
  comparing a proposed scenario's simulated outcomes against a baseline, with
  quantified deltas and risks the simulation can't capture.

Three resources track the model's data: `topology`, `simulation_results`, and
`design_decision`, each versioned per scenario/seed/comparison.
