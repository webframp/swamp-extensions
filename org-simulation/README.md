# @webframp/org-simulation

Agent-guided organization design simulation model for swamp, inspired by the
[Curious Duck simulation studio](https://ducksimng.onrender.com/scenarios/studio).

Captures an organization as a topology of **teams**, **repos/modules**,
**environments** (with a defect/reliability model), and **customer bases**,
wired together by connectors. Then runs a deterministic, seedable flow
simulation to estimate feature/bug cycle times, defect detection, find-vs-fix
balance, and customer sentiment (NPS) — producing versioned, comparable
scenario snapshots for organization design decisions.

## Why This Extension

Restructuring proposals ("split the platform team," "move to continuous
deploy," "add a dedicated QA discipline") are usually argued from intuition.
This extension gives you a lightweight, deterministic simulation to make the
argument with numbers: model the current org, model the proposed change, run
both under the same conditions, and compare the deltas before committing to a
disruptive reorg.

It supports:

- **Modeling**: Capture team structure, code ownership, deploy cadence, and
  customer base as a versioned topology snapshot
- **Simulation**: Run a seedable, reproducible flow simulation over a chosen
  time horizon
- **Comparison**: Run the same seed against multiple scenarios (current vs.
  proposed) for an apples-to-apples read
- **Decision tracking**: Record adopt/reject/iterate/hold decisions tied to
  specific simulated deltas, with risks the simulation can't capture

## Conceptual Foundations

The topology and defect model mirror the DuckSim studio's canvas primitives:

- **Teams**: members with disciplines (Programmer/Tester/Analyst/
  Operations/Manager) and skills, plus a working disposition (urgency vs.
  quality) and collaboration mode (solo/pairing/ensemble/swarm)
- **Repos**: modules a team owns and writes code into
- **Environments**: deployment targets with a defect model — a
  `certaintyBaseline` (floor code quality under max recklessness) and
  `riskSensitivity` (how much careful practice improves quality), plus a
  deploy policy (continuous/weekly/monthly)
- **Customer bases**: populations that periodically experience an environment
  and whose satisfaction (and eventual NPS/churn) responds to whether that
  experience was healthy or buggy
- **Connectors**: directed wires expressing team→repo ownership, repo→
  environment deployment, team→environment operation, and customerBase→
  environment usage

## Design Principles

**Snapshot-based, per scenario.** Each `design_topology` call writes a full
topology under a `scenarioLabel` — `"current"` for the as-is org, or a
descriptive label like `"split-platform-team"` for a proposed redesign. Every
scenario is independently addressable and simulatable.

**System-dynamics approximation, not pixel-for-pixel replay.** The simulation
tracks continuous backlog levels per team/ticket-type and integrates queue
time (Little's Law) for cycle times, while stepping day-by-day for
path-dependent state (code certainty, customer satisfaction, churn). It's
directional, not predictive to the decimal.

**Deterministic and seedable.** The same topology + seed always produces the
same result. Run multiple seeds to gauge variance before trusting a single
run's numbers.

**Agent-guided, not computed from vibes.** The agent interviews the user to
build the topology, runs simulations, and records a decision — but the
decision itself, including risks the simulation can't see, is agent judgment
persisted as data.

## Usage

```bash
# Create an org-simulation instance
swamp model create @webframp/org-simulation my-org \
  --global-arg 'organizationContext=Mid-size SaaS company, ~40 engineers across 6 teams'

# Capture the current org as a topology scenario
swamp model method run my-org design_topology

# Run the simulation against it
swamp model method run my-org run_simulation \
  --input 'scenarioLabel=current' --input 'seed=0'

# Capture a proposed redesign as a second scenario
swamp model method run my-org design_topology \
  --input 'scenarioLabel=split-platform-team'

# Run the same seed against the proposed scenario for a fair comparison
swamp model method run my-org run_simulation \
  --input 'scenarioLabel=split-platform-team' --input 'seed=0'

# Record the comparison decision
swamp model method run my-org record_design_decision
```

## Querying Data

```bash
# Read back a topology scenario
swamp data get my-org topology-current --json

# Read simulation results for a scenario/seed pair
swamp data get my-org results-current-seed0 --json

# Read a recorded decision
swamp data get my-org decision-split-platform-team-vs-current --json

# List all versions
swamp data list my-org --json
```

## Resources

### topology

Snapshot of one organization design scenario: widgets, connectors, metrics
config. Instance name: `topology-<slugified-scenarioLabel>`.

**Widget types:** `team`, `repo`, `environment`, `customerBase` — each with a
type-specific `config` (see `mod.ts` for full schemas).

### simulation_results

Outcomes of one deterministic simulation run. Instance name:
`results-<slug>-seed<N>`.

| Field | Description |
|-------|-------------|
| cycles | Per-ticket-type (bug/incident/feature/request/internal) average cycle time and completed count |
| flow | Work-in-flight over time, final in-flight count |
| defects | Cumulative detected/fixed/outstanding, detection series over time |
| sentiment | Final NPS, customer count, churn, NPS series over time |
| reliability | Average code certainty, healthy/buggy cell counts, certainty series over time |
| deployCount | Number of deploys that occurred during the run |

### design_decision

A recorded comparison decision. Instance name:
`decision-<slug(scenarioLabel)>-vs-<slug(baselineLabel)>`.

## Methods

### design_topology

Capture an organization design scenario (teams, repos, environments, customer
bases, connectors, metrics config) through structured conversation. Call once
per scenario — `"current"` for the as-is org, then a descriptive label per
proposed redesign.

### run_simulation

Run the deterministic flow simulation against a previously-designed topology
scenario. Supports a seed for reproducibility and an optional horizon
override (`3mo`/`6mo`/`12mo`/`all`).

### record_design_decision

Record a decision (`adopt`/`reject`/`iterate`/`hold`) comparing a proposed
scenario's simulated outcomes against a baseline, with quantified deltas and
risks the simulation can't capture.

## Simulation Model Notes

- **Throughput** scales with team size, average skill (0-100 normalized),
  disposition (urgency ships faster, quality is more careful), collaboration
  mode (solo is fastest per-person; pairing/ensemble/swarm trade throughput
  for coordination/quality), and `coordinationEase`/`collaborationEffectiveness`.
- **Code certainty** for newly-written code is an exponential approach from
  an environment's `certaintyBaseline` toward the global `ceilingCertainty`,
  driven by the writing team's quality effort and the environment's
  `riskSensitivity`.
- **Bug detection** is driven by the tester fraction of a team and how buggy
  their connected environments currently are; undetected bugs in
  tester-light teams surface as customer-facing incidents instead.
- **Customer sentiment** samples every `experienceFrequency` days: a healthy
  experience nudges satisfaction up, a buggy one nudges it down and risks
  churn (probability `1/patience`).
- **Deploy policy** (continuous/weekly/monthly + interval) only affects
  feature/bug cycle time via an average deploy-wait latency — it does not
  gate whether work completes, only when it's considered "shipped."

## Complements

| Extension | How it complements org-simulation |
|-----------|-----------------------------------|
| `@webframp/team-topology` | Discover/assess team structure and Conway's Law fit before simulating changes to it |
| `@webframp/rice-scoring` | Prioritize which simulated redesigns to pursue first |
| `@magistr/good-planning` | Track adopted redesigns as commitments with hypotheses and tripwires |
