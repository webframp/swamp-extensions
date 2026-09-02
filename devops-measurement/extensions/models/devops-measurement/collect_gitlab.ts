/**
 * GitLab collector — Collection context anticorruption layer for GitLab.
 *
 * A transformation service at the boundary: it takes raw GitLab activity
 * (merge requests with approvers and merge timestamps, MR notes, and commits)
 * already fetched by @webframp/gitlab, resolves the crews involved against the
 * crew reference, and emits the uniform `event` vocabulary. The GitLab-ness of
 * the data ends here — downstream sees only events.
 *
 * Why the raw data arrives as method arguments rather than being fetched here:
 * swamp models cannot call other models' methods from TypeScript. The workflow
 * runs @webframp/gitlab's list_merge_requests / list_mr_notes / list_commits
 * first, then wires their stored output into this model's `sync` via CEL
 * (data.latest(...)). This keeps the collector a pure translation function —
 * the reuse-correct shape — and keeps @webframp/gitlab the single owner of the
 * GitLab API surface.
 *
 * ── Upstream shape contract (IMPORTANT for anyone editing this collector) ──
 *
 * @webframp/gitlab is a GENERIC gitlab client and emits FLAT, per-call result
 * envelopes — it must NOT be changed to pre-group data for us. Each envelope is
 * the `.attributes` of one `data.latest("gitlab", "<instance>")`:
 *
 *   list_merge_requests → { project: string, mergeRequests: MR[], ... }
 *   list_mr_notes       → { project: string, noteableIid: number, notes: N[] }
 *   list_commits        → { project: string, commits: C[], ... }
 *
 * The grouping key (project, and for notes the MR iid) lives on the ENVELOPE,
 * NOT on the individual record — an MR carries `iid` but no project; a note and
 * a commit carry neither. So this collector consumes ARRAYS OF ENVELOPES and
 * threads the envelope's project/iid onto each record during translation. That
 * "molding" is exactly anticorruption-layer work and belongs here, not upstream.
 *
 * Emits three event types (ubiquitous-language.md):
 * - mr_review   — an approver reviewed an MR (approver helps the MR author)
 * - mr_comment  — a non-system note on an MR (commenter helps the MR author)
 * - commit      — a commit to a project (author helps the project's crew)
 *
 * Crew tagging (the two Go lookup ports, now data passed in):
 * - source crew = the actor's crew (username -> crew)
 * - target crew = the crew owning the project (projectId -> crew)
 *
 * DR-2: each event's resource instance name is a deterministic hash of its
 * STABLE identity (never the MR's mutable updatedAt), so swamp's versioned data
 * deduplicates re-observations instead of accumulating them.
 * DR-5: `sync` returns an unresolvedCrews count so a missing/mis-seeded roster
 * is visible rather than silently zeroing cross-boundary scores.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import {
  canonicalActor,
  type Event,
  EventSchema,
  newEvent,
} from "./_lib/event.ts";

const EXTENSION_NAME = "@webframp/devops-measurement";

// =============================================================================
// Upstream shape contract — the FLAT envelopes @webframp/gitlab actually emits.
// These mirror @webframp/gitlab's MergeRequestListSchema / NoteListSchema /
// CommitListSchema. Only the fields this collector reads are declared; extra
// fields on the real envelopes are ignored (Zod strips unknowns on parse).
// =============================================================================

/** A merge-request record inside a list envelope (no project on the record). */
const GitLabMergeRequestSchema = z.object({
  iid: z.number(),
  author: z.object({ username: z.string() }).nullable().default(null),
  updatedAt: z.string().default(""),
  mergedAt: z.string().nullable().default(null),
  approvers: z.array(z.string()).default([]),
});

/**
 * One `list_merge_requests` result envelope: a project plus its MRs. The
 * `project` here is the grouping key threaded onto each MR's events.
 */
const GitLabMergeRequestListSchema = z.object({
  project: z.string().describe("Project the merge requests belong to"),
  mergeRequests: z.array(GitLabMergeRequestSchema).default([]),
});

/** A note record inside a notes envelope (no project/mr ref on the record). */
const GitLabNoteSchema = z.object({
  id: z.number().describe(
    "Stable note id from @webframp/gitlab — the identity key for the event",
  ),
  author: z.object({ username: z.string() }).nullable().default(null),
  body: z.string().default(""),
  createdAt: z.string().default(""),
  // @webframp/gitlab's list_mr_notes returns human notes; there is no `system`
  // flag to filter on here.
});

/**
 * One `list_mr_notes` result envelope: a project + the MR iid + that MR's
 * notes. Both grouping keys live on the envelope.
 */
const GitLabNoteListSchema = z.object({
  project: z.string().describe("Project the MR belongs to"),
  noteableIid: z.number().describe("The MR iid these notes belong to"),
  notes: z.array(GitLabNoteSchema).default([]),
});

/** A commit record inside a commits envelope (no project on the record). */
const GitLabCommitSchema = z.object({
  id: z.string(),
  authorName: z.string().default(""),
  authorEmail: z.string().default(""),
  committedDate: z.string().default(""),
});

/** One `list_commits` result envelope: a project plus its commits. */
const GitLabCommitListSchema = z.object({
  project: z.string().describe("Project the commits belong to"),
  commits: z.array(GitLabCommitSchema).default([]),
});

/**
 * The crew reference, passed in from the crew-reference model (via CEL in the
 * workflow). Only the lookups this collector needs.
 */
const CrewReferenceSchema = z.object({
  members: z.array(
    z.object({
      username: z.string(),
      crewId: z.string(),
      aliases: z.array(z.string()).optional(),
    }),
  ).default([]),
  mappings: z.array(
    z.object({
      crewId: z.string(),
      mappingType: z.string(),
      value: z.string(),
    }),
  ).default([]),
});

// =============================================================================
// Output schema
// =============================================================================

const EventBatchSchema = z.object({
  events: z.array(EventSchema).describe("Translated cross-source events"),
  count: z.number().describe("Number of events produced"),
  unresolvedCrews: z.number().describe(
    "Activities whose source or target crew could not be resolved (DR-5): a " +
      "signal that the crew reference is missing entries, not an error",
  ),
  source: z.literal("gitlab"),
  fetchedAt: z.string().optional(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

// =============================================================================
// GlobalArgs
// =============================================================================

const GlobalArgsSchema = z.object({});

// =============================================================================
// Lookups — the swamp-native form of collectors.CrewLookup / UserCrewLookup
// =============================================================================

type CrewReference = z.infer<typeof CrewReferenceSchema>;

/** Build username -> crewId and (project value) -> crewId lookup maps. */
export function buildLookups(ref: CrewReference): {
  userCrew: (username: string) => string;
  projectCrew: (projectId: string) => string;
  isMember: (username: string) => boolean;
  canonical: (raw: string) => string;
  resolveActor: (
    candidates: string[],
    fallback?: string,
  ) => { userId: string; sourceCrew: string };
} {
  const byUser = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const m of ref.members) {
    byUser.set(m.username, m.crewId);
    // Canonical identity: the member's own username maps to itself, and every
    // alias maps to the canonical username — so one person is one userId.
    aliases.set(m.username, m.username);
    for (const a of m.aliases ?? []) aliases.set(a, m.username);
  }

  const byProject = new Map<string, string>();
  for (const m of ref.mappings) {
    if (m.mappingType === "project") byProject.set(m.value, m.crewId);
  }

  const canonical = (raw: string) => canonicalActor(raw, aliases);
  /**
   * Resolve an actor from several source identifiers (e.g. a git commit's
   * author NAME and EMAIL). Tries each candidate through the alias map and
   * returns the FIRST that resolves to a known member — so a person whose email
   * is a registered alias but whose free-form git name is not still resolves to
   * their canonical username (not a fragmented email-keyed identity). When no
   * candidate is a member, falls back to the explicit `fallback` identity (the
   * git email is more stable than a display name), or the first non-empty
   * candidate when no fallback is given.
   */
  const resolveActor = (
    candidates: string[],
    fallback?: string,
  ): { userId: string; sourceCrew: string } => {
    for (const c of candidates) {
      if (c === "") continue;
      const canon = canonical(c);
      if (byUser.has(canon)) {
        return { userId: canon, sourceCrew: byUser.get(canon)! };
      }
    }
    // No candidate is a member. Use the explicit fallback identity when given
    // (git email is more stable than a free-form display name), else the first
    // non-empty candidate.
    const chosen = (fallback && fallback !== "")
      ? fallback
      : (candidates.find((c) => c !== "") ?? "");
    return { userId: canonical(chosen), sourceCrew: "" };
  };

  return {
    // Resolve crew via the CANONICAL identity, so an alias still finds the crew.
    userCrew: (username: string) => byUser.get(canonical(username)) ?? "",
    projectCrew: (projectId: string) => byProject.get(projectId) ?? "",
    isMember: (username: string) => byUser.has(canonical(username)),
    canonical,
    resolveActor,
  };
}

// =============================================================================
// Translation — pure functions, the heart of the ACL
// =============================================================================

type SyncArgs = {
  mergeRequestLists: z.infer<typeof GitLabMergeRequestListSchema>[];
  mrNotesLists: z.infer<typeof GitLabNoteListSchema>[];
  commitLists: z.infer<typeof GitLabCommitListSchema>[];
  crewReference: CrewReference;
};

type TranslateResult = { events: Event[]; unresolvedCrews: number };

/**
 * Translate raw GitLab activity into events. Pure and total: exported so it is
 * unit-testable without a model context. Counts unresolved crews for DR-5.
 *
 * Consumes ARRAYS OF ENVELOPES (one per project / per MR) and threads each
 * envelope's project / noteableIid onto the records it contains — the grouping
 * the flat upstream shapes don't carry on the records themselves.
 */
export function translate(args: SyncArgs): TranslateResult {
  const { userCrew, projectCrew, canonical, resolveActor } = buildLookups(
    args.crewReference,
  );
  const events: Event[] = [];
  let unresolvedCrews = 0;

  const noteUnresolved = (sourceCrew: string, targetCrew: string) => {
    if (sourceCrew === "" || targetCrew === "") unresolvedCrews++;
  };

  // --- mr_review: each approver helped the MR author ---
  // project comes from the ENVELOPE; the MR record carries only its iid.
  for (const list of args.mergeRequestLists) {
    const targetCrew = projectCrew(list.project);
    for (const mr of list.mergeRequests) {
      const targetUser = mr.author?.username ?? "";
      for (const approver of mr.approvers) {
        const actor = canonical(approver);
        const sourceCrew = userCrew(approver);
        noteUnresolved(sourceCrew, targetCrew);
        events.push(
          newEvent(
            {
              userId: actor,
              username: actor,
              eventType: "mr_review",
              sourceCrew,
              targetCrew,
              targetUser: canonical(targetUser),
              projectId: list.project,
              timestamp: mr.mergedAt ?? mr.updatedAt,
              metadata: { mergedAt: mr.mergedAt, mrIid: mr.iid },
            },
            // STABLE identity: project + MR + approver + type. Never updatedAt.
            [list.project, mr.iid, actor, "mr_review"],
          ),
        );
      }
    }
  }

  // --- mr_comment: each note author helped the MR author ---
  // project + MR iid come from the ENVELOPE; the note carries only author+time.
  for (const list of args.mrNotesLists) {
    const targetCrew = projectCrew(list.project);
    // The MR author for this note group is not on the note; resolve it from the
    // MR envelopes by (project, iid).
    const mrAuthor = findMrAuthor(
      args.mergeRequestLists,
      list.project,
      list.noteableIid,
    );
    for (const note of list.notes) {
      const author = canonical(note.author?.username ?? "");
      if (author === "") continue; // cannot attribute a note with no author
      const sourceCrew = userCrew(author);
      noteUnresolved(sourceCrew, targetCrew);
      events.push(
        newEvent(
          {
            userId: author,
            username: author,
            eventType: "mr_comment",
            sourceCrew,
            targetCrew,
            targetUser: canonical(mrAuthor),
            projectId: list.project,
            timestamp: note.createdAt,
          },
          // STABLE identity: project + MR + note id + type. The note's own id
          // is stable across re-observation, unlike a positional index —
          // list_mr_notes returns a sliding window (last N), so an index would
          // re-mint unchanged comments with new eventIds whenever a newer
          // comment shifted the window (HIGH finding), inflating activity.
          [list.project, list.noteableIid, note.id, "mr_comment"],
        ),
      );
    }
  }

  // --- commit: each commit author helped the project's crew ---
  // project comes from the ENVELOPE; the commit record carries only the SHA.
  for (const list of args.commitLists) {
    const targetCrew = projectCrew(list.project);
    for (const c of list.commits) {
      // Resolve the actor from BOTH the git author name AND email — either may
      // be the registered alias that maps to the member's canonical username.
      // Using only the name fragmented a person whose email (not name) is the
      // registered alias into a separate email-keyed identity (CRITICAL finding).
      const { userId: actor, sourceCrew } = resolveActor([
        c.authorName,
        c.authorEmail,
      ], c.authorEmail);
      noteUnresolved(sourceCrew, targetCrew);
      events.push(
        newEvent(
          {
            userId: actor,
            username: c.authorName || actor,
            eventType: "commit",
            sourceCrew,
            targetCrew,
            // commit has no single helped user; the target is the crew
            targetUser: "",
            projectId: list.project,
            timestamp: c.committedDate,
          },
          // STABLE identity: project + commit SHA. The SHA alone is not enough
          // — the same SHA can appear under two projects (fork/cherry-pick),
          // and keying on SHA-only would dedup them to the first-seen project's
          // crew (MEDIUM finding). Project + SHA keeps them distinct.
          [list.project, c.id, "commit"],
        ),
      );
    }
  }

  return { events, unresolvedCrews };
}

function findMrAuthor(
  lists: z.infer<typeof GitLabMergeRequestListSchema>[],
  project: string,
  iid: number,
): string {
  for (const list of lists) {
    if (list.project !== project) continue;
    for (const mr of list.mergeRequests) {
      if (mr.iid === iid) return mr.author?.username ?? "";
    }
  }
  return "";
}

// =============================================================================
// Context type
// =============================================================================

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** GitLab collector model — translates raw GitLab activity into events. */
export const model = {
  type: "@webframp/devops-measurement/collect-gitlab",
  version: "2026.09.01.1",
  upgrades: [],
  globalArguments: GlobalArgsSchema,

  resources: {
    events: {
      description: "Cross-source events translated from GitLab activity",
      schema: EventBatchSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    sync: {
      description:
        "Translate raw GitLab activity (merge requests with approvers/merge " +
        "timestamps, MR notes, and commits — fetched by @webframp/gitlab and " +
        "wired in via CEL) into uniform events. A fan-out factory: processes " +
        "all supplied projects in one execution. Writes each event to a " +
        "deterministic instance name so re-runs deduplicate via versioned " +
        "data. Reports an unresolvedCrews count when the crew reference is " +
        "missing entries.",
      arguments: z.object({
        mergeRequestLists: z.array(GitLabMergeRequestListSchema).default([])
          .describe(
            "Array of @webframp/gitlab list_merge_requests result envelopes " +
              "(each { project, mergeRequests[] }). One per project; wire via " +
              "CEL from each list_merge_requests instance's data.latest.",
          ),
        mrNotesLists: z.array(GitLabNoteListSchema).default([]).describe(
          "Array of @webframp/gitlab list_mr_notes result envelopes (each " +
            "{ project, noteableIid, notes[] }). One per MR.",
        ),
        commitLists: z.array(GitLabCommitListSchema).default([]).describe(
          "Array of @webframp/gitlab list_commits result envelopes (each " +
            "{ project, commits[] }). One per project.",
        ),
        crewReference: CrewReferenceSchema.describe(
          "Crew reference snapshot (members + project mappings) via CEL",
        ),
      }),
      execute: async (
        args: SyncArgs,
        context: MethodContext,
      ) => {
        const startMs = Date.now();
        const { events, unresolvedCrews } = translate(args);

        const handle = await context.writeResource(
          "events",
          "gitlab-events",
          {
            events,
            count: events.length,
            unresolvedCrews,
            source: "gitlab",
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );

        if (unresolvedCrews > 0) {
          context.logger.warn(
            "GitLab collector: {unresolved} activities had an unresolved " +
              "source or target crew — check the crew reference roster/mappings",
            { unresolved: unresolvedCrews },
          );
        }
        context.logger.info(
          "GitLab collector: {count} events ({unresolved} with unresolved crews)",
          { count: events.length, unresolved: unresolvedCrews },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
