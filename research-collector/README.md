# @webframp/research-collector

Gathers intelligence from Hacker News, Lobste.rs, SRE Weekly, IFIN Discourse,
and RedMonk. Produces typed resources for downstream workflows like daily
briefings and journal entries.

## Usage

```bash
# Create the model instance
swamp model create @webframp/research-collector research-collector \
  --global-arg hnCount=20 --global-arg lobstersCount=20 \
  --global-arg sreCount=5 --global-arg ifinCount=15 \
  --global-arg redmonkCount=5

# Gather all sources
swamp model method run research-collector gather
```

## Methods

| Method | Description |
|--------|-------------|
| `gather` | Fetches HN front page, Lobste.rs hottest, SRE Weekly issues, IFIN topics, and RedMonk articles |

## Configurable counts

| Arg | Default | Range | Description |
|-----|---------|-------|-------------|
| `hnCount` | 20 | 5-50 | HN front-page stories |
| `lobstersCount` | 20 | 5-50 | Lobste.rs hottest stories |
| `sreCount` | 5 | 1-20 | SRE Weekly issues |
| `ifinCount` | 15 | 5-50 | IFIN Discourse topics |
| `redmonkCount` | 5 | 1-20 | RedMonk articles |
