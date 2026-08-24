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

| Method              | Description                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
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

| Arg          | Default              | Description                                                                                                               |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `orgDir`     | `~/org`              | Root of org-mode repo                                                                                                     |
| `jrnlSubdir` | `journal`            | Subdirectory for journal files                                                                                            |
| `swampBin`   | `~/.local/bin/swamp` | Path to swamp binary                                                                                                      |
| `repoDir`    | `/tmp/swamp-fresh`   | Swamp repo for data queries                                                                                               |
| `sources`    | all seven sources    | Which sources to include: `hn`, `lobsters`, `sre`, `ifin`, `redmonk`, `arxiv`, `aiDailyBrief`. Drop a name to disable it. |

## Troubleshooting

### Entry not created despite data being available

The extension checks if a file for today already exists (`YYYY-MM-DD-dow.org`).
If one exists, the method returns `status: "already-exists"` as an idempotent
no-op. There is no force-refresh mechanism — delete the existing file manually
to regenerate.

### `status: "skipped-no-data"`

The `readResearchData()` helper could not find research-collector output in the
swamp catalog. Run the research-collector model before this one. The helper
tries two spec names and silently returns null if both fail to parse.

### `status: "committed-not-pushed"` — git push failed

The journal file was written to disk and committed to git, but `git push` failed
(no remote, auth failure, network). The data is safe locally. Fix the remote
configuration and push manually or re-run — the next run will skip because the
file already exists.

### `status: "written-not-committed"` — git commit failed

The file was written to disk but `git commit` threw (e.g., `.git/index.lock`
contention). The file exists on disk but is not version-controlled. The error
details are only visible in the method logs, not in the resource output.

### `swampBin` and `repoDir` defaults differ from README

The source defaults are `swampBin: "swamp"` (PATH lookup) and `repoDir: "."`
(current directory). The README documents different defaults. When creating the
model instance, set these explicitly if your environment differs.

### Output includes only a subset of available sources

Items from each source are sliced: HN (10), Lobste.rs (10), IFIN (8), AI Daily
Brief nuggets (8 per edition), arXiv authors (3 per entry), and source URLs
(10). Larger source datasets are truncated without indication.

## Dependencies

Expects `research-collector` data in the swamp catalog and a git-initialized org
repo at `orgDir`.
