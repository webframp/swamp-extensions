# Writing a collector

A collector is the Collection-context anticorruption layer for one source. It
takes raw activity that a **generic** upstream model already fetched, molds it
into the uniform `event` vocabulary, and writes an event batch. This document is
the contract every collector follows so a new one (a fifth source) is easy to
add.

The four shipped collectors — `collect_gitlab`, `collect_redmine`,
`collect_teams`, `collect_cloudtrail` — are the worked examples. Read one
alongside this doc.

## The one rule that shapes everything

**Do not change the upstream model to suit us.** `@webframp/gitlab`,
`@webframp/redmine`, `@webframp/microsoft/teams`, and `@swamp/aws/cloudtrail`
are generically useful clients. They emit whatever shape is natural for their
API. Molding that shape into events is _our_ job and belongs _here_, in the
collector. That is precisely what an anticorruption layer is for.

## Where the grouping key lives: envelope vs. record

Upstream data comes in one of two shapes. Know which before you write the
collector.

- **Envelope-grouped** (GitLab, Teams): the upstream returns one result object
  per project / per MR / per channel. The grouping key (project id, MR iid,
  channel id) lives on the **envelope**, and the individual records inside do
  **not** carry it. Your collector consumes an **array of envelopes** and
  threads the envelope's key onto each record it contains.
  - GitLab MRs: `{ project, mergeRequests[] }` — an MR has `iid` but no project.
  - GitLab notes: `{ project, noteableIid, notes[] }` — a note has neither.
  - GitLab commits: `{ project, commits[] }` — a commit has no project.
  - Teams: `{ channelId, messages[] }` — a message has no channel ref.

- **Self-contained** (Redmine, CloudTrail): each record already carries its own
  keys. Your collector consumes a flat **array of records**.
  - Redmine issue:
    `{ id, project: {id, name}, author: {id, name}, journals[] }`.
  - CloudTrail event:
    `{ username, eventSource, eventName, eventTime, readOnly }`.

Advertise whichever shape you consume as a named Zod schema whose name mirrors
the upstream (e.g. `GitLabMergeRequestListSchema`, `RedmineIssueSchema`), with a
top-of-file "Upstream shape contract" comment. Only declare the fields you read;
Zod strips unknown fields on parse, so extra upstream fields are harmless.

## The collector skeleton

Every collector has the same five parts:

1. **Upstream input schemas** — named after the upstream, documenting the shape.
2. **`CrewReferenceSchema`** — the subset of the crew reference you need
   (`members[]` always; `mappings[]` if you resolve a resource→crew). Members
   carry an optional `aliases[]`.
3. **`buildLookups(ref)`** — returns resolver closures. Always include
   `canonical(raw)`; include `userCrew(name)` and whichever of `projectCrew(id)`
   / `channelCrew(id)` your source needs. `userCrew` MUST resolve through
   `canonical` so an alias still finds the crew.
4. **`translate(args): { events, unresolvedCrews }`** — a PURE, exported
   function (unit-testable without a model context). It is the heart of the ACL.
5. **The model** — a `sync` method that calls `translate`, writes the batch to
   `writeResource("events", "<source>-events", {...})`, logs, and warns on
   `unresolvedCrews > 0`.

## What `translate` must do

- **Thread the grouping key.** For envelope shapes, read `project`/`channelId`/
  `noteableIid` off the envelope and set it as each event's `projectId` (and use
  it in the identity parts). For self-contained shapes, read it off the record
  (convert types as needed — Redmine's `project.id` is a number; stringify it).

- **Canonicalize every actor and helped-user identity** through
  `canonical(...)`. Sources identify people differently (GitLab username,
  Redmine/Teams display name, git author name/email, IAM username).
  Canonicalizing to the crew member's username via the reference's `aliases[]`
  is what keeps one person as one `userId` across all sources. Skipping this
  fragments a person into several scored users — the single most important
  correctness rule after the cross-boundary predicate.

- **Set crews by role.** Source crew = the actor's crew (`userCrew`). Target
  crew = the crew that owns the touched resource (`projectCrew`/`channelCrew`),
  or the empty string when the source has no meaningful owning crew (CloudTrail
  — the breadth rule). Never compute the cross-boundary predicate yourself; the
  scorer and graph apply `isCrossBoundary` from `_lib/event.ts`. You just tag
  the crews.

- **Build every event through `newEvent(fields, identityParts)`** from
  `_lib/event.ts`. Never construct an event literal. `identityParts` MUST be the
  activity's STABLE identity — fields that never change for the same real-world
  event (a commit SHA; `project + MR iid + approver`;
  `project + issue + journal
  id`). NEVER include a mutable field (an MR's
  `updatedAt`, a title). Stable identity is what lets swamp's versioned data
  deduplicate re-observations instead of double-counting them.

- **Count `unresolvedCrews`.** Increment it whenever a source or target crew you
  expected to resolve came back empty. Return it so a mis-seeded roster is
  visible rather than silently zeroing scores. (For CloudTrail, target crew is
  intentionally always empty — only count an unresolved _source_ crew there.)

- **Emit the right event type** from the closed `EventTypeEnum`
  (`mr_review | mr_comment | commit | teams_message | redmine_comment |
  cloudtrail`).
  If a new source needs a new activity kind, add it to the enum in
  `_lib/event.ts` AND to `DEFAULT_WEIGHTS` (a weight is core policy — discuss
  it).

- **Carry force-multiplier inputs in `metadata`** when the source has them: a
  review's paired merge timestamp (`{ mergedAt }`), a first-response pair
  (`{ taggedAt, respondedAt }`). The scorer reads these; absent them the
  corresponding metric is simply zero.

## Schema gotcha: `.optional()` vs `.default([])`

A Zod field declared `z.array(...).default([])` becomes **required** in the
parsed _output_ type, which forces every caller (including tests) to supply it.
For fields your code already guards with `?? []` (like `aliases`, `replies`),
declare them `.optional()` instead so callers may omit them.

## Output contract (what the aggregator expects)

`sync` must write a batch with at least: `events: Event[]`, `source: string` (a
literal for your source), `unresolvedCrews: number`. The `events` aggregation
model unions these, applies the window once, and dedups by `eventId`. Write to
instance name `"<source>-events"` (unique per collector; do not collide).

## Wiring into the workflow

Add a step that runs your collector's `sync`, wiring its inputs by CEL from the
upstream model's stored output — e.g.
`${{ data.latest("<upstream-model>", "<instance>").attributes }}`. For
envelope-grouped sources, pass an **array** with one entry per upstream instance
you ran. Mark the step `allowFailure: true` if the source is optional, and have
`aggregate` depend on it with `condition: completed` (not `succeeded`) so a
missing source degrades gracefully.
