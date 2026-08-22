# @webframp/research-collector

Gathers intelligence from Hacker News, Lobste.rs, arXiv, SRE Weekly, IFIN
Discourse, RedMonk, and The AI Daily Brief. Produces typed resources for
downstream workflows like daily briefings and journal entries.

## Usage

```bash
# Create the model instance with default counts
swamp model create @webframp/research-collector research-collector

# Gather all sources
swamp model method run research-collector gather
```

## Methods

| Method   | Description                                                          |
| -------- | ------------------------------------------------------------------- |
| `gather` | Fetches HN, Lobste.rs, arXiv, SRE Weekly, IFIN, RedMonk, AI Daily Brief |

## Configurable counts

```bash
# Tune how many stories per source
swamp model edit research-collector \
  --global-arg hnCount=30 --global-arg lobstersCount=15
```

| Arg                 | Default | Range  | Description                                          |
| ------------------- | ------- | ------ | --------------------------------------------------- |
| `hnCount`           | 20      | 5-50   | Hacker News front-page stories                       |
| `lobstersCount`     | 20      | 5-50   | Lobste.rs hottest stories                            |
| `sreCount`          | 5       | 1-20   | SRE Weekly issues                                    |
| `ifinCount`         | 15      | 5-50   | IFIN Discourse topics                                |
| `redmonkCount`      | 5       | 1-20   | RedMonk articles                                     |
| `arxivCount`        | 8       | 1-30   | arXiv paper entries                                  |
| `aiDailyBriefDays`  | 3       | 1-14   | The AI Daily Brief editions (one per day, newest first) |

## The AI Daily Brief source

The site at <https://aidailybrief.ai/> publishes a daily written edition at
`/e/YYYY-MM-DD` — a headline, a thesis, and a set of written analysis
"nuggets". Each edition also links to the podcast/video episode; the collector
**keeps only the written analysis** and discards video/audio embeds, so
briefings get articles + research analysis rather than video sources.

## Troubleshooting

**A source shows up empty (`stories: []`, `topics: []`, etc.) in the
`brief` resource.** `gather` fans out to all seven sources in parallel and
each is independently wrapped so one source's failure never fails the
whole method — a failed source silently degrades to an empty
array/object rather than surfacing an error field on the resource. Check
the model's logs for `Source "<name>" failed to gather; continuing with
partial data: ...` to tell "the site had nothing new" apart from "the
fetch or parse failed."

**AI Daily Brief editions are missing or incomplete.** This source is
HTML-scraped via regex matches against specific CSS classes
(`ed-h1`, `nug-wrap`, `nug-h`, `nug-b`, `tag`) rather than a structured
API. If aidailybrief.ai changes its markup, the per-edition parse throws
and that edition is silently dropped (not retried, not flagged) — check
logs as above, and expect this source to need a code update if the site
redesigns.

**arXiv entries are empty or sparse.** arXiv's API is rate-limited and
occasionally unreliable; `gatherArxiv` catches failures and returns zero
entries rather than failing the whole `gather` call. Retrying the method
later usually recovers it.

**Changing a `*Count`/`aiDailyBriefDays` arg has no effect, or errors.**
These are global args validated at `model edit` time against the ranges
in the table above (e.g. `hnCount` must be an integer 5–50) — an
out-of-range value is rejected before any fetch happens, not silently
clamped.
