# @webframp/devops-measurement

Observe DevOps team effectiveness through **cross-boundary collaboration**.

The organization runs several crews. Some people do most of their work inside
their own crew; others regularly help other crews — reviewing their merge
requests, answering their questions, committing to their repositories. Those
people are *force multipliers*: their leverage extends past their assigned team.
This extension identifies them, ranks them, and shows the collaboration network
they form.

It is an **observation engine**, not a system of record. It watches the tools
the organization already uses, records each activity as an immutable event
tagged with the crew that performed it and the crew that benefited, and reasons
over the accumulated record. Events are append-only; crews and members are
reference data; scoring is a pure function of history that can be re-run at any
time against the same events.

This realizes the DDD design documented in the measurement system's design docs
(their Milestone 9, "swamp integration"), built swamp-native: models observe,
versioned data is the event log, a workflow orchestrates the stages.

## How it works

The pipeline has four stages. Each is a model method; the bundled workflow wires
them into one DAG.

1. **Collect.** One translation model per source (`collect-gitlab`,
   `collect-redmine`, `collect-teams`, `collect-cloudtrail`). Each `sync`
   consumes the upstream extension's flat output, canonicalizes actor identity
   against the crew reference, and emits uniform cross-boundary events. The
   collector *is* the anti-corruption layer: the generic upstream extension
   stays generic, and all source-specific shape knowledge lives here.
2. **Aggregate.** The `events` model's `aggregate` gathers every collector's
   events into one deduplicated event log. Because each event's id is a content
   hash of its *stable* identity, re-observing the same activity writes a new
   *version* of the same resource — swamp's versioned data does the
   deduplication, so re-running a collector never double-counts.
3. **Score and graph, in parallel.**
   - `scoring` computes each member's cross-boundary ratio, reach, tier, and
     force-multiplier flag — a pure function of the event log.
   - `interaction-graph` builds the HELPED graph (who helped whom across crew
     boundaries) and computes centrality in-data.
4. **Report.** `force_multiplier_report` joins the scoring and graph outputs
   into a tier table and a force-multiplier summary.

## Architecture

The design's bounded contexts map onto swamp primitives:

| Context           | Swamp realization                                                  |
| ----------------- | ------------------------------------------------------------------ |
| Collection        | One translation model per source, each `sync` a fan-out factory    |
| Crew Reference    | `crew-reference` model — crews, members, mappings as a snapshot     |
| Event Log         | `events` model — the deduplicated, append-only observation record  |
| Scoring (core)    | `scoring` model — cross-boundary ratio, reach, tier, force-multiplier |
| Network Analysis  | `interaction-graph` model — nodes, HELPED edges, centrality in-data |
| Presentation      | `force_multiplier_report` — tier table + force-multiplier summary  |
| Orchestration     | One workflow DAG: collect → aggregate → score + graph → report     |

The shared kernel is `_lib/event.ts`: the uniform event vocabulary, the single
`newEvent` factory, the one cross-boundary predicate, and the deterministic
`eventId`. Every collector funnels through it so the event shape is defined in
exactly one place.

## Models

| Model                 | Type                                          | Methods            |
| --------------------- | --------------------------------------------- | ------------------ |
| Crew Reference        | `@webframp/devops-measurement/crew-reference` | `load`, `derive`   |
| GitLab collector      | `@webframp/devops-measurement/collect-gitlab` | `sync`             |
| Redmine collector     | `@webframp/devops-measurement/collect-redmine`| `sync`             |
| Teams collector       | `@webframp/devops-measurement/collect-teams`  | `sync`             |
| CloudTrail collector  | `@webframp/devops-measurement/collect-cloudtrail` | `sync`         |
| Event log             | `@webframp/devops-measurement/events`         | `aggregate`        |
| Scoring               | `@webframp/devops-measurement/scoring`        | `score`, `trend`   |
| Interaction graph     | `@webframp/devops-measurement/interaction-graph` | `build`         |

## Getting started

### 1. Load the crew reference

```bash
swamp model create @webframp/devops-measurement/crew-reference crew-reference

# Load reviewed crew data (idempotent — safe to re-run)
swamp model method run crew-reference load --input-file crews.json
```

`load` enforces two invariants: a resource maps to exactly one crew, and every
member and mapping names a known crew. A bad reference set fails loudly at load
rather than silently mis-tagging every event that touches the resource.

`derive` builds the roster from GitLab group membership (via
`@webframp/gitlab`'s `list_members`) plus a crew taxonomy, so the reference set
can be regenerated from live group data instead of hand-maintained.

### 2. Collect from each source

Each collector reads the upstream extension's output and emits events. Wire the
upstream data in via CEL in the workflow, or pass it directly for a one-off:

```bash
swamp model create @webframp/devops-measurement/collect-gitlab collect-gitlab
swamp model method run collect-gitlab sync --input-file gitlab-envelope.json
```

The collector consumes the upstream's flat envelope shape (for GitLab:
`mergeRequestLists`, `mrNotesLists`, `commitLists`) plus the crew reference. See
`extensions/models/devops-measurement/COLLECTORS.md` for the full contract every
collector follows — the shape it consumes, how it canonicalizes identity, and
how it emits events. That document is the entry point for adding a collector for
a new source.

### 3. Aggregate, score, graph, report

```bash
swamp model method run events aggregate       # merge all collectors' events
swamp model method run scoring score          # tiers + force-multiplier flags
swamp model method run interaction-graph build # HELPED graph + centrality
swamp report get @webframp/devops-measurement/force-multiplier-report
```

Or run the whole pipeline as one workflow:

```bash
swamp workflow run <the bundled measure workflow>
```

## Identity resolution

The same person appears as a GitLab username, a Redmine display name, a Teams
`displayName`, and an IAM/git email. The crew reference's `aliases` map every
known source identifier to one canonical member username, so a single person is
one scored `userId` across all four sources. A collector resolves a commit actor
from *both* the git author name and email, so a member whose email — not name —
is the registered alias still resolves correctly rather than fragmenting into a
separate identity.

## Centrality

Centrality is driven by user activity across reviews, comments, and commits. The
graph model computes PageRank over the HELPED graph as the primary centrality
signal (a pure power-method — no external graph database), with in-degree
(distinct people you helped) as a documented fallback. HELPED edges point
helped→helper, so a node's incoming degree counts the people who depended on it.

## Status

All contexts are implemented: crew reference, four collectors, the aggregated
event log, scoring (with six-month trend), the interaction graph (PageRank and
inverse bus factor), and the force-multiplier report, orchestrated by the
bundled workflow. CloudTrail collection is built but stays dark until a matching
activity-source upstream model exists (`@swamp/aws/cloudtrail` is
infrastructure-management, not `LookupEvents`). See `RELEASE_NOTES.md`.
