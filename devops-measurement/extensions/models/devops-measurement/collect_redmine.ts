/**
 * Redmine collector — Collection context anticorruption layer for Redmine.
 *
 * Translates Redmine issue journals (comments), already fetched by
 * @webframp/redmine `get_issue`, into `redmine_comment` events. A journal note
 * author helps the issue author; the target crew owns the issue's project.
 *
 * ── Upstream shape contract ──
 *
 * @webframp/redmine `get_issue` returns a SELF-CONTAINED issue detail record —
 * unlike GitLab, the grouping keys live on the record, not an envelope:
 *
 *   { id, project: { id: number, name }, author: { id, name },
 *     journals: [ { id, user: { id, name }, notes, createdOn } ], createdOn }
 *
 * So this collector consumes an ARRAY OF ISSUE DETAILS directly. Note the
 * Redmine-isms it molds: project id is a NUMBER (converted to string for the
 * crew mapping lookup), and identity is a display NAME (`user.name`,
 * `author.name`), not a username — the crew reference's aliases[] are how those
 * display names resolve to canonical member usernames.
 *
 * Faithful to the Go ACL (internal/collectors/redmine.go): journals with empty
 * notes (status changes with no comment) are dropped in translation. Adds the
 * force-multiplier input the design calls for (gap 5): first-response timing —
 * taggedAt = issue creation, respondedAt = the FIRST non-empty journal — ride
 * in metadata so the scorer can compute median response time.
 *
 * Same wiring model as collect_gitlab: raw Redmine data arrives as method
 * arguments (CEL-wired from @webframp/redmine's stored output); this stays a
 * pure translation function.
 *
 * SPDX-License-Identifier: Apache-2.0
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
// Upstream shape contract — @webframp/redmine get_issue issue-detail record.
// Self-contained (project + author + journals on the record). Only the fields
// this collector reads are declared; extra fields are ignored on parse.
// =============================================================================

const RedmineJournalSchema = z.object({
  id: z.number(),
  user: z.object({ id: z.number(), name: z.string() }),
  notes: z.string().default(""),
  createdOn: z.string().default(""),
});

/** A Redmine issue detail as produced by @webframp/redmine get_issue. */
const RedmineIssueSchema = z.object({
  id: z.number(),
  project: z.object({ id: z.number(), name: z.string() }).describe(
    "Owning project; project.id (a number) keys the crew mapping",
  ),
  author: z.object({ id: z.number(), name: z.string() }).describe(
    "Issue author — the person helped by a comment (display name)",
  ),
  createdOn: z.string().default("").describe("Issue creation time"),
  journals: z.array(RedmineJournalSchema).default([]),
});

const CrewReferenceSchema = z.object({
  members: z.array(z.object({
    username: z.string(),
    crewId: z.string(),
    aliases: z.array(z.string()).optional(),
  })).default([]),
  mappings: z.array(
    z.object({
      crewId: z.string(),
      mappingType: z.string(),
      value: z.string(),
    }),
  ).default([]),
});

const EventBatchSchema = z.object({
  events: z.array(EventSchema),
  count: z.number(),
  unresolvedCrews: z.number(),
  source: z.literal("redmine"),
  fetchedAt: z.string().optional(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

const GlobalArgsSchema = z.object({});

// =============================================================================
// Lookups + translation
// =============================================================================

type CrewReference = z.infer<typeof CrewReferenceSchema>;

/** Build username -> crewId and (project value) -> crewId lookup maps. */
export function buildLookups(ref: CrewReference): {
  userCrew: (username: string) => string;
  projectCrew: (projectId: string) => string;
  canonical: (raw: string) => string;
} {
  const byUser = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const m of ref.members) {
    byUser.set(m.username, m.crewId);
    aliases.set(m.username, m.username);
    for (const a of m.aliases ?? []) aliases.set(a, m.username);
  }
  const byProject = new Map<string, string>();
  for (const m of ref.mappings) {
    if (m.mappingType === "project") byProject.set(m.value, m.crewId);
  }
  const canonical = (raw: string) => canonicalActor(raw, aliases);
  return {
    userCrew: (u: string) => byUser.get(canonical(u)) ?? "",
    projectCrew: (p: string) => byProject.get(p) ?? "",
    canonical,
  };
}

type SyncArgs = {
  issues: z.infer<typeof RedmineIssueSchema>[];
  crewReference: CrewReference;
};
type TranslateResult = { events: Event[]; unresolvedCrews: number };

/**
 * Translate Redmine issue activity into uniform cross-boundary events: an actor
 * from one crew who touches an issue owned by another crew helped that crew.
 * Pure function — the heart of this collector's anti-corruption layer.
 */
export function translate(args: SyncArgs): TranslateResult {
  const { userCrew, projectCrew, canonical } = buildLookups(args.crewReference);
  const events: Event[] = [];
  let unresolvedCrews = 0;

  for (const issue of args.issues) {
    // project.id is a number upstream; the crew mapping keys on its string form.
    const projectId = String(issue.project.id);
    const targetCrew = projectCrew(projectId);
    const issueAuthor = issue.author.name;
    // First non-empty journal is the first response to the issue.
    const firstResponse = issue.journals.find((j) => j.notes !== "");

    for (const j of issue.journals) {
      if (j.notes === "") continue; // status change, no comment — dropped
      const author = canonical(j.user.name);
      const sourceCrew = userCrew(j.user.name);
      if (sourceCrew === "" || targetCrew === "") unresolvedCrews++;

      // Attach response timing only to the first response, keyed off issue
      // creation — the design's Redmine first-response derivation.
      const metadata: Record<string, unknown> = {};
      if (
        firstResponse && j.id === firstResponse.id && issue.createdOn !== ""
      ) {
        metadata.taggedAt = issue.createdOn;
        metadata.respondedAt = j.createdOn;
      }

      events.push(
        newEvent(
          {
            userId: author,
            username: author,
            eventType: "redmine_comment",
            sourceCrew,
            targetCrew,
            targetUser: canonical(issueAuthor),
            projectId,
            timestamp: j.createdOn,
            metadata,
          },
          // STABLE identity: the journal id is unique per issue.
          [projectId, issue.id, j.id, "redmine_comment"],
        ),
      );
    }
  }
  return { events, unresolvedCrews };
}

// =============================================================================
// Context + model
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

/** Redmine collector model — translates issue journals into events. */
export const model = {
  type: "@webframp/devops-measurement/collect-redmine",
  version: "2026.09.01.1",
  upgrades: [],
  globalArguments: GlobalArgsSchema,

  resources: {
    events: {
      description: "Events translated from Redmine issue journals",
      schema: EventBatchSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    sync: {
      description:
        "Translate Redmine issue journals (from @webframp/redmine get_issue, " +
        "wired via CEL) into redmine_comment events. Fan-out over all issues. " +
        "Drops empty-note journals; derives first-response timing into " +
        "metadata; reports unresolvedCrews.",
      arguments: z.object({
        issues: z.array(RedmineIssueSchema).default([]).describe(
          "Array of @webframp/redmine get_issue issue-detail records (each " +
            "self-contained: project, author, journals). Wire via CEL from " +
            "each get_issue instance's data.latest.",
        ),
        crewReference: CrewReferenceSchema.describe("Crew reference via CEL"),
      }),
      execute: async (args: SyncArgs, context: MethodContext) => {
        const startMs = Date.now();
        const { events, unresolvedCrews } = translate(args);

        const handle = await context.writeResource("events", "redmine-events", {
          events,
          count: events.length,
          unresolvedCrews,
          source: "redmine",
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });

        if (unresolvedCrews > 0) {
          context.logger.warn(
            "Redmine collector: {n} activities with unresolved crews",
            { n: unresolvedCrews },
          );
        }
        context.logger.info("Redmine collector: {count} events", {
          count: events.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
