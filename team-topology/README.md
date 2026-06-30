# @webframp/team-topology

Agent-guided team topology and value stream mapping model for swamp.

Captures teams (type, cognitive load, domains), interactions (modes, health),
system ownership, and value stream flows as versioned snapshots. Designed for
incremental discovery through structured conversations — the agent interviews,
the model persists.

## Why This Extension

Organizations struggling with delivery speed, quality, or team burnout often
have a *topology problem* — teams structured in ways that create unnecessary
handoffs, cognitive overload, or Conway's Law mismatches between team boundaries
and system architecture. But these problems are invisible without a structured
way to capture and analyze the current state.

This extension makes team topology visible and queryable as versioned data. It
supports:

- **Discovery**: Map what exists today through guided conversations
- **Analysis**: Identify cognitive load issues, Conway mismatches, and flow bottlenecks
- **Evolution tracking**: Version history shows how topology changes over time
- **Decision support**: Data to inform restructuring proposals (tracked via `@magistr/good-planning`)

## Conceptual Foundations

- **Team Topologies** (Skelton & Pais): 4 fundamental team types, 3 interaction
  modes, cognitive load as the primary constraint
- **Conway's Law**: team structure determines system architecture — and vice
  versa. Make the coupling explicit.
- **Westrum organizational typology**: pathological → bureaucratic → generative
  culture predicts information flow quality
- **GROWS method tracer bullets**: map one thin slice end-to-end before
  expanding to the full picture
- **Ruth Malan**: architecture decisions (including team boundaries) are
  hypotheses — treat them as experiments with success criteria
- **Value Stream Mapping (lean)**: lead time, process time, wait time, %C&A
  at each step reveals where flow breaks down

## Design Principles

**Snapshot-based.** One `topology` resource holds all teams, interactions, and
system dependencies — versioned atomically. The agent discovers incrementally
through conversation but writes the full topology each time. Version history IS
the evolution story.

**No state machine for discovery.** Call methods in any order, start wherever
you have information. One team? A whole org? A single value stream? All valid
starting points.

**Agent-guided, not computed.** The model is a structured knowledge store. The
agent conducts interviews, identifies patterns, and records findings. Analysis
is agent judgment persisted as data — not a formula.

**Tracer bullet approach.** Start with one value stream, map the teams involved,
identify one interaction problem. Expand from there. Don't try to capture
everything on the first pass.

## Usage

```bash
# Create a topology instance for your org/area
swamp model create @webframp/team-topology my-org \
  --global-arg 'organizationContext=Platform engineering division, ~60 engineers across 8 teams' \
  --global-arg 'scope=platform-division'

# Discover teams and interactions (agent-guided conversation)
swamp model method run my-org discover_topology

# Map a value stream end-to-end
swamp model method run my-org map_flow

# Record assessment findings
swamp model method run my-org record_assessment
```

## Querying Data

```bash
# Read back the current topology
swamp data get my-org topology-current --json

# Read flows
swamp data get my-org flows-current --json

# Read assessment
swamp data get my-org assessment-current --json

# List all versions (version history = topology evolution)
swamp data list my-org --json
```

## Workflow: From Discovery to Action

### Phase 1: Tracer Bullet (one value stream)

Pick the most painful or most important value stream. Map the teams involved.

```bash
swamp model method run my-org discover_topology \
  --input 'teams=[{"name":"Checkout","type":"stream-aligned","domains":["payments","cart"],"systems":["checkout-api","payment-gateway"],"size":6}]'
```

Then map how work flows through it:

```bash
swamp model method run my-org map_flow \
  --input 'streams=[{"name":"Feature Delivery","purpose":"Ship features to customers","steps":[{"name":"Design","ownerTeam":"Checkout","leadTimeDays":2},{"name":"Build","ownerTeam":"Checkout","leadTimeDays":5},{"name":"Deploy","ownerTeam":"Platform","leadTimeDays":1}]}]'
```

### Phase 2: Expand the Map

Add more teams, interactions, and system dependencies as you learn. Each
`discover_topology` call writes a new version with the complete picture.

### Phase 3: Assess

Read the topology and flows data, then record your analysis:

```bash
swamp model method run my-org record_assessment \
  --input 'findings=[{"id":"CL-01","category":"cognitive-load","severity":"critical","title":"Checkout team overloaded","description":"Owns payments AND cart AND shipping notifications","affectedTeams":["Checkout"],"recommendation":"Split along domain boundaries"}]' \
  --input 'summary=Primary bottleneck is Checkout team cognitive overload.'
```

### Phase 4: Plan Changes

Use `@magistr/good-planning` to track restructuring proposals as commitments
with hypotheses, signposts, and tripwires. Use `@webframp/rice-scoring` to
prioritize which changes to tackle first.

## Resources

### topology

Atomic snapshot of team structure, interactions, and system ownership.

**Teams:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | yes | Team name |
| type | enum | yes | `stream-aligned`, `enabling`, `complicated-subsystem`, `platform` |
| domains | string[] | yes | Business domains or bounded contexts owned |
| systems | string[] | no | Systems, services, or repos owned (defaults to []) |
| cognitiveLoad | object | no | `{intrinsic, extraneous, germane, capacity}` — each 0-10 |
| size | number | no | Number of team members |
| culture | enum | no | Westrum: `pathological`, `bureaucratic`, `generative` |
| notes | string | no | Freeform context |

**Interactions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| source | string | yes | Source team name |
| target | string | yes | Target team name |
| mode | enum | yes | `collaboration`, `x-as-a-service`, `facilitating` |
| purpose | string | yes | Why these teams interact |
| duration | enum | no | `permanent`, `temporary`, `evolving` (default: permanent) |
| health | enum | no | `flowing`, `friction`, `blocked` (default: flowing) |
| notes | string | no | Additional context |

**System Dependencies:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| from | string | yes | Consuming system/service |
| to | string | yes | Providing system/service |
| type | enum | yes | `sync`, `async`, `shared-db`, `file`, `manual` |
| ownerFrom | string | no | Team owning the consumer |
| ownerTo | string | no | Team owning the provider |

### flows

Value stream maps with step-level metrics.

**Value Stream:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | yes | Stream name |
| purpose | string | yes | What value it delivers and to whom |
| trigger | string | no | What initiates work |
| steps | FlowStep[] | yes | Ordered steps |
| totalLeadTimeDays | number | no | End-to-end lead time |
| notes | string | no | Additional context |

**Flow Step:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | yes | Step name |
| ownerTeam | string | yes | Team responsible |
| leadTimeDays | number | no | Total elapsed time for this step |
| processTimeDays | number | no | Actual hands-on work time |
| waitTimeDays | number | no | Time queued/waiting |
| percentCompleteAccurate | number | no | %C&A: work arriving without needing rework (0-100) |
| notes | string | no | Additional context |

### assessment

Agent-produced findings about topology health.

**Finding:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | yes | Short ID (e.g., CL-01, CW-03) |
| category | enum | yes | See categories below |
| severity | enum | yes | `info`, `warning`, `critical` |
| title | string | yes | One-line summary |
| description | string | yes | Detailed explanation |
| affectedTeams | string[] | yes | Teams impacted |
| recommendation | string | no | What to do about it |

**Finding categories:** `cognitive-load`, `conways-mismatch`,
`interaction-friction`, `bottleneck`, `missing-team`, `team-coupling`,
`culture`, `other`

## Methods

### discover_topology

Map teams, interactions, and system ownership through guided conversation.
The agent guides through: team inventory → type classification → domain/system
ownership → cognitive load → interaction mapping → system dependencies.

### map_flow

Map value streams end-to-end using a tracer-bullet approach. Captures steps,
owner teams, and optional flow metrics. Each call replaces the full flows
resource — include all streams, not just new ones.

### record_assessment

Record analysis findings after reviewing topology and flows. The agent reads
existing data, identifies problems across five categories, and persists
structured findings with severities and recommendations.

## Team Types

| Type | Purpose | Signal |
|------|---------|--------|
| stream-aligned | Delivers value directly along a flow of work | "We ship features to users" |
| enabling | Helps other teams acquire capabilities (temporary) | "We teach/coach, then leave" |
| complicated-subsystem | Owns deep-specialist knowledge | "You need a PhD to understand this" |
| platform | Provides self-service internal capabilities | "Other teams use our APIs/tools" |

Most teams should be stream-aligned. If your org has more platform teams than
stream-aligned teams, that's a signal worth investigating.

## Interaction Modes

| Mode | What it looks like | Duration expectation |
|------|-------------------|---------------------|
| collaboration | Pairing, shared standups, joint design | Temporary (weeks to months) |
| x-as-a-service | API calls, tickets, self-service | Permanent |
| facilitating | Teaching, coaching, pair-programming to transfer skill | Temporary |

**Key heuristic:** Collaboration should evolve to x-as-a-service over time. If
a collaboration interaction has been active for 6+ months, that's a signal —
either define a clear contract and transition, or merge the teams.

## Cognitive Load Model

Three dimensions (after Sweller's cognitive load theory):

- **Intrinsic** (0-10): complexity inherent to the domain — irreducible
- **Extraneous** (0-10): overhead from environment, tooling, process — reducible
- **Germane** (0-10): investment in learning and improvement — desirable

**Capacity** (0-10): total cognitive bandwidth (typically 7-8 for a well-staffed
team of 5-8 people).

**Overload signal:** When `intrinsic + extraneous ≥ capacity`, the team cannot
invest in germane load (learning/improvement). Symptoms: slow delivery, high
defect rate, burnout, knowledge silos.

**Interventions:**
- Reduce extraneous: better tooling, simpler processes, platform self-service
- Reduce intrinsic: narrow the team's domain scope, split the team
- Increase capacity: add people (diminishing returns beyond ~8)

## Complements

| Extension | How it complements team-topology |
|-----------|--------------------------------|
| `@webframp/ddd-guidance` | Bounded contexts map to team domain ownership |
| `@magistr/good-planning` | Track restructuring proposals as commitments with hypotheses |
| `@webframp/rice-scoring` | Prioritize which topology changes to tackle first |
| `@webframp/aws/event-topology` | Technical dependency graph to validate Conway alignment |
