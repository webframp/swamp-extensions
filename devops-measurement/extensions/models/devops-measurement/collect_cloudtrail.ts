/**
 * CloudTrail collector — Collection context anticorruption layer for AWS
 * CloudTrail.
 *
 * Translates CloudTrail write events (already fetched by @swamp/aws/cloudtrail)
 * into `cloudtrail` events. This finishes the second collector the Go system
 * left stubbed.
 *
 * The ENCODED DOMAIN RULE, preserved exactly from the Go
 * `ParseCloudTrailEvent`: target crew is ALWAYS empty. CloudTrail measures a
 * person's breadth of services touched, NOT help given to another crew, so a
 * CloudTrail event can never be cross-boundary (the cross-boundary predicate
 * requires a non-empty target crew). `projectId` carries the AWS service name
 * (EventSource), which is what makes it a breadth indicator. Read-only events
 * are dropped in translation.
 *
 * ── Upstream shape contract ──
 *
 * @swamp/aws/cloudtrail emits SELF-CONTAINED per-event records — no envelope
 * grouping is needed (unlike GitLab/Teams). This collector consumes a flat
 * ARRAY OF EVENTS:
 *
 *   { username, eventSource, eventName, eventTime, readOnly }
 *
 * Identity is the IAM username; the crew reference's aliases[] map it to the
 * canonical member username so a person is one userId across sources.
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
// Upstream shape contract — @swamp/aws/cloudtrail per-event record (flat, no
// envelope). Only the fields this collector reads are declared.
// =============================================================================

/** A CloudTrail event as produced by @swamp/aws/cloudtrail. */
const CloudTrailEventSchema = z.object({
  username: z.string().default(""),
  eventSource: z.string().default("").describe(
    "AWS service, e.g. ec2.amazonaws.com",
  ),
  eventTime: z.string().default(""),
  eventName: z.string().default(""),
  readOnly: z.boolean().default(false),
});

const CrewReferenceSchema = z.object({
  members: z.array(z.object({
    username: z.string(),
    crewId: z.string(),
    aliases: z.array(z.string()).optional(),
  })).default([]),
});

const EventBatchSchema = z.object({
  events: z.array(EventSchema),
  count: z.number(),
  unresolvedCrews: z.number(),
  source: z.literal("cloudtrail"),
  fetchedAt: z.string().optional(),
  durationMs: z.number().optional(),
  collectedBy: z.string().optional(),
});

const GlobalArgsSchema = z.object({});

// =============================================================================
// Lookups + translation
// =============================================================================

type CrewReference = z.infer<typeof CrewReferenceSchema>;

/** Build username -> crewId and (account/resource) -> crewId lookup maps. */
export function buildLookups(ref: CrewReference): {
  userCrew: (username: string) => string;
  canonical: (raw: string) => string;
} {
  const byUser = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const m of ref.members) {
    byUser.set(m.username, m.crewId);
    aliases.set(m.username, m.username);
    for (const a of m.aliases ?? []) aliases.set(a, m.username);
  }
  const canonical = (raw: string) => canonicalActor(raw, aliases);
  return { userCrew: (u: string) => byUser.get(canonical(u)) ?? "", canonical };
}

type SyncArgs = {
  events: z.infer<typeof CloudTrailEventSchema>[];
  crewReference: CrewReference;
};
type TranslateResult = { events: Event[]; unresolvedCrews: number };

/**
 * Translate CloudTrail management events into uniform cross-boundary events: an
 * IAM principal from one crew who acts on an account/resource owned by another
 * crew helped that crew. Pure function — this collector's anti-corruption layer.
 */
export function translate(args: SyncArgs): TranslateResult {
  const { userCrew, canonical } = buildLookups(args.crewReference);
  const events: Event[] = [];
  let unresolvedCrews = 0;

  for (const e of args.events) {
    if (e.readOnly) continue; // breadth is about actions taken, not reads
    if (e.username === "" || e.eventSource === "") continue;
    const actor = canonical(e.username);
    const sourceCrew = userCrew(e.username);
    // Only the SOURCE crew can be unresolved here — target is always empty by
    // design, so we only count a missing source crew.
    if (sourceCrew === "") unresolvedCrews++;

    events.push(
      newEvent(
        {
          userId: actor,
          username: actor,
          eventType: "cloudtrail",
          sourceCrew,
          // ENCODED DOMAIN RULE: target crew ALWAYS empty (breadth, not help).
          targetCrew: "",
          targetUser: "",
          projectId: e.eventSource, // AWS service name = breadth indicator
          timestamp: e.eventTime,
          metadata: { eventName: e.eventName },
        },
        // STABLE identity: actor + service + action + time uniquely identify
        // the observed API call.
        [e.username, e.eventSource, e.eventName, e.eventTime, "cloudtrail"],
      ),
    );
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

/** CloudTrail collector model — translates AWS write events into events. */
export const model = {
  type: "@webframp/devops-measurement/collect-cloudtrail",
  version: "2026.09.01.1",
  upgrades: [],
  globalArguments: GlobalArgsSchema,

  resources: {
    events: {
      description: "Events translated from CloudTrail write activity",
      schema: EventBatchSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    sync: {
      description:
        "Translate CloudTrail write events (from @swamp/aws/cloudtrail, wired " +
        "via CEL) into cloudtrail events. Fan-out over all events. Target crew " +
        "is always empty (breadth, not cross-crew help) — these never count as " +
        "cross-boundary. Read-only events are dropped. Reports unresolvedCrews.",
      arguments: z.object({
        events: z.array(CloudTrailEventSchema).default([]).describe(
          "Array of @swamp/aws/cloudtrail per-event records (self-contained). " +
            "Wire via CEL from the cloudtrail instance's data.latest.",
        ),
        crewReference: CrewReferenceSchema.describe("Crew reference via CEL"),
      }),
      execute: async (args: SyncArgs, context: MethodContext) => {
        const startMs = Date.now();
        const { events, unresolvedCrews } = translate(args);

        const handle = await context.writeResource(
          "events",
          "cloudtrail-events",
          {
            events,
            count: events.length,
            unresolvedCrews,
            source: "cloudtrail",
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );

        if (unresolvedCrews > 0) {
          context.logger.warn(
            "CloudTrail collector: {n} events with unresolved source crew",
            { n: unresolvedCrews },
          );
        }
        context.logger.info("CloudTrail collector: {count} events", {
          count: events.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
