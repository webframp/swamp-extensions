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

## License

Apache-2.0
