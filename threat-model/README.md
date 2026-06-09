# @webframp/threat-model

Agile threat modeling as an agent-guided concept model for swamp. Guides
structured threat assessment through progressive discovery, stores versioned
threat models, and provides a compact posture snapshot for periodic monitoring.

## Prerequisites

- [swamp](https://github.com/swamp-club/swamp) CLI installed

## Installation

```bash
swamp extension pull @webframp/threat-model
```

## Usage

### Create a model instance

```bash
swamp model create @webframp/threat-model assessment
```

### Create with custom scales

```bash
swamp model create @webframp/threat-model assessment \
  --global-arg likelihoodScale="certain = by design, probable = likely, possible = compound, unlikely = theoretical" \
  --global-arg impactScale="critical = full compromise, high = significant exposure, medium = limited, low = minimal" \
  --global-arg mitigationFramework="CWE Monster Mitigations"
```

### Progressive assessment flow

The model guides threat assessment through five progressive methods:

```bash
# 1. Define scope and assets
swamp model method run assessment scope \
  --input subject="API key generation feature" \
  --input scope="Key lifecycle: generation, storage, usage, revocation" \
  --input currentPosture="All auth flows through IdC with short-lived tokens"

# 2. Identify threat scenarios (agent-guided)
swamp model method run assessment identify \
  --input threats='[{"id":"T1","title":"Session controls bypassed","description":"API keys bypass IdC session policies","likelihood":"certain","impact":"medium","exploitation":"Stolen key used from any IP without MFA","mitigatingFactors":"Blast radius limited to inference only"}]'

# 3. Evaluate risk matrix and record open questions
swamp model method run assessment evaluate \
  --input openQuestions='["What is the deprovisioning propagation delay?"]'

# 4. Define controls and produce recommendation
swamp model method run assessment mitigate \
  --input controls='[{"id":"C1","description":"Document credential class in secrets inventory","mitigates":["T1"],"effectiveness":"partial","implemented":false}]' \
  --input recommendation="Enable with compensating controls"

# 5. Generate posture snapshot
swamp model method run assessment posture
```

### Check current risk posture

```bash
swamp model method run assessment posture
swamp data get assessment current  # full assessment
```

### Revisit after changes

```bash
swamp model method run assessment revisit \
  --input changesNoted='["New OIDC auth option available upstream"]'
```

## Methodology

The model implements agile threat modeling with these concepts:

**Risk Matrix:** Likelihood (certain/probable/possible/unlikely) × Impact
(critical/high/medium/low) → Risk Level (critical/high/medium/low/negligible).
Computed automatically for each scenario.

**Threat Status Tracking:** Each threat is classified as:
- `mitigated` — control reduces risk below threshold
- `accepted` — risk acknowledged with stated rationale
- `deferred` — awaiting external input (open questions)
- `unaddressed` — no decision made (the gap)

**Posture Snapshot:** A compact summary answering "where do we stand?" at a
glance. Reports overall posture as acceptable, conditionally-acceptable, or
unacceptable based on unaddressed high/critical threats.

**Progressive Discovery:** Methods build on each other:
`scope → identify → evaluate → mitigate → posture`, with `revisit` to
re-enter the loop when the system changes.

## License

Apache-2.0
