# @webframp/research-collector

Gathers intelligence from Hacker News, Lobste.rs, arXiv, SRE Weekly, IFIN
Discourse, and RedMonk. Produces typed resources for downstream workflows
like daily briefings and journal entries.

## Usage

```bash
# Create the model instance with default counts
swamp model create @webframp/research-collector research-collector

# Gather all sources
swamp model method run research-collector gather
```

## Methods

| Method | Description |
|--------|-------------|
| `gather` | Fetches HN, Lobste.rs, arXiv, SRE Weekly, IFIN, and RedMonk |

## Configurable counts

```bash
# Tune how many stories per source
swamp model edit research-collector \
  --global-arg hnCount=30 --global-arg lobstersCount=15
```

| Arg | Default | Range | Description |
|-----|---------|-------|-------------|
| `hnCount` | 20 | 5-50 | Hacker News front-page stories |
| `lobstersCount` | 20 | 5-50 | Lobste.rs hottest stories |
| `sreCount` | 5 | 1-20 | SRE Weekly issues |
| `ifinCount` | 15 | 5-50 | IFIN Discourse topics |
| `redmonkCount` | 5 | 1-20 | RedMonk articles |
| `arxivCount` | 8 | 1-30 | arXiv paper entries |
