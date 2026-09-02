## 2026.09.01.1

**Added:** Initial release — an observation engine for DevOps cross-boundary
collaboration, realizing the measurement system's DDD design (Milestone 9:
swamp integration) swamp-natively.

Shared kernel (`_lib/event.ts`, not a model): the uniform event schema, the
`newEvent` factory, the single cross-boundary predicate, and a deterministic
`eventId` (content hash of an activity's stable identity) used as each event's
resource instance name — so swamp's versioned data deduplicates re-observations
instead of accumulating them.

Models:

- **crew-reference** — crews, members, and resource→crew mappings as one
  versioned snapshot. `load` enforces one-crew-per-resource and known-crew
  invariants; `derive` builds the roster swamp-natively from GitLab group
  membership plus a crew taxonomy.
- **collect-gitlab** — translates GitLab merge-request reviews, comments, and
  commits into events. Emits `mr_review`, `mr_comment`, `commit`; carries the
  paired merge timestamp for unblock-rate scoring.
- **collect-redmine** — translates Redmine issue journals into `redmine_comment`
  events; drops empty-note journals; derives first-response timing.
- **collect-teams** — translates Teams channel messages into `teams_message`
  events; @mentions become helped users.
- **collect-cloudtrail** — translates CloudTrail write events into `cloudtrail`
  events with an always-empty target crew (breadth, not cross-crew help — these
  never count as cross-boundary).
- **events** — unions the collector batches, applies the rolling window once,
  and dedups by eventId into one canonical event set.
- **scoring** — cross-boundary ratio, cross-crew count, crew reach, depth,
  unblock rate, and median response time (hours); classifies tiers; computes a
  six-month trend (`trend`) comparing a prior run to the current one. Does not
  set centrality/rank — that is the graph model's job.
- **interaction-graph** — Person nodes and HELPED edges from all cross-boundary
  activity. Centrality is PageRank over the HELPED graph (a pure power-method,
  no external graph database), with normalized in-degree as the documented
  fallback when the graph has no edges. Also computes each person's inverse
  bus-factor contribution and detects hubs and bridges.

Report:

- **force-multiplier** (workflow scope) — joins scores with graph centrality,
  re-classifies tiers (centrality gates Tier 1), and renders the tier table plus
  hub/bridge network summary. Degrades, never throws.

Workflow:

- **measure** — collect (four sources, parallel) → aggregate → score ‖ graph →
  force-multiplier report. Steps wire prior models' data via CEL.

Weights and the cross-boundary rule are preserved exactly from the reference Go
implementation as core policy. PageRank centrality, the six-month trend, and the
inverse bus-factor signal — deferred in early drafts — are implemented and
exercised in this release. Interactive dashboard filters remain out of scope.
CloudTrail collection is built but stays dark until a matching activity-source
upstream model exists.

**Upgrade note:** First version. No prior state to migrate.
