# @webframp/hermes-journal-writer

Reads research-collector data from the swamp catalog and writes org-mode journal
entries to `~/org/journal/`. Commits and pushes to the org repo so entries
become part of your living knowledge store.

## Usage

```bash
# First ensure research data has been gathered
swamp workflow run research-brief

# Write the daily journal entry
swamp model method run journal-writer write_daily_entry

# The entry is appended to ~/org/journal/YYYY-MM.org, then
# committed and pushed to the org repo automatically.
```

## Methods

| Method              | Description                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `write_daily_entry` | Reads the latest research-collector brief and appends a dated org entry with Hacker News, Lobste.rs, arXiv, SRE Weekly, IFIN, RedMonk, and The AI Daily Brief content. |

## Org entry format

Each entry is an org-mode heading with a properties drawer containing tags,
source URLs, source counts, and timestamps:

```org
*** 2026-06-14 Sun
:PROPERTIES:
:SOURCE: research-brief
:TAGS: research security supply-chain
:SOURCES: https://... (first 10 URLs)
:UPDATED: 2026-06-14 18:03:35Z
:END:

Research brief — 20 HN, 20 Lobste.rs, 5 SRE Weekly, 15 IFIN, 5 RedMonk, 3 AI Daily Brief
```

## Global arguments

| Arg          | Default              | Description                    |
| ------------ | -------------------- | ------------------------------ |
| `orgDir`     | `~/org`              | Root of org-mode repo          |
| `jrnlSubdir` | `journal`            | Subdirectory for journal files |
| `swampBin`   | `~/.local/bin/swamp` | Path to swamp binary           |
| `repoDir`    | `/tmp/swamp-fresh`   | Swamp repo for data queries    |
| `sources`    | all seven sources    | Which sources to include: `hn`, `lobsters`, `sre`, `ifin`, `redmonk`, `arxiv`, `aiDailyBrief`. Drop a name to disable it. |

## Dependencies

Expects `research-collector` data in the swamp catalog and a git-initialized org
repo at `orgDir`.
