# @webframp/rice-scoring

RICE scoring methodology as an agent-guided concept model for swamp. Accepts
items to prioritize, conducts structured interviews to derive Reach, Impact,
Confidence, and Effort values, then produces ranked versioned scorecards.

Configurable scales via globalArguments allow teams to anchor scoring in their
own context — whether "reach" means users per quarter, API requests per month,
or teams affected.

## Prerequisites

- [swamp](https://github.com/swamp-club/swamp) CLI installed

## Installation

```bash
swamp extension pull @webframp/rice-scoring
```

## Usage

### Create a model instance

```bash
swamp model create @webframp/rice-scoring scoring
```

### Create with custom scales

```bash
swamp model create @webframp/rice-scoring scoring \
  --global-arg reachDefinition="API requests per month" \
  --global-arg reachScale="1-100 logarithmic" \
  --global-arg effortUnit="story points" \
  --global-arg scoringContext="Platform team Q3 planning"
```

### Score items

The `score` method is agent-guided — an agent conducts a structured interview
per item, gathering values for each RICE dimension before calling the method
with final numbers:

```bash
swamp model method run scoring score \
  --arg items='[{"name":"Feature A","description":"New onboarding flow","reach":8,"impact":2,"confidence":0.8,"effort":3,"rationale":{"reach":"Affects ~8000 MAU","impact":"High friction reduction","confidence":"Backed by user research","effort":"3 person-weeks"}}]'
```

### View ranked scores

```bash
swamp model method run scoring rank
```

## How RICE Works

Each item is scored across four dimensions:

- **Reach** — How many users/entities does this affect?
- **Impact** — How much does it move the needle per entity reached?
- **Confidence** — How certain are we about these estimates?
- **Effort** — How much work does it take to deliver?

The final score is computed as:

```
RICE = (Reach × Impact × Confidence) / Effort
```

Higher scores indicate higher priority. Items are stored sorted by score
descending.

## Troubleshooting

### `rank` throws "No scores found"

The `rank` method reads the stored scorecard from a prior `score` invocation. If
`score` has not been run yet (or the resource was garbage-collected), `rank`
throws with instructions to run `score` first.

### Invalid scorecard format after schema changes

If a stored scorecard was written by an older extension version and the schema
changed, `rank` throws a Zod validation error with details about which fields
are invalid. Re-run `score` with the current version to regenerate.

### Global args are informational only

The `reachDefinition`, `impactScale`, `effortUnit`, etc. global arguments are
guidance strings for the agent during the scoring interview. They do not affect
the computation (which is always `reach * impact * confidence / effort`).

## License

Apache-2.0
