/**
 * Teams collector — Collection context anticorruption layer for MS Teams.
 *
 * Translates Teams channel messages (already fetched by
 * @webframp/microsoft/teams) into `teams_message` events. The message sender
 * helps the crew that owns the channel; when the message @mentions specific
 * users, those are the helped users (one edge per mention). This finishes one
 * of the two collectors the Go system left stubbed — in swamp the upstream
 * model already speaks Graph, so there is no deferred-SDK excuse.
 *
 * ── Upstream shape contract ──
 *
 * @webframp/microsoft/teams `channelMessages` emits one envelope per channel:
 *
 *   { teamId, channelId, channelName,
 *     messages: [ { id, createdDateTime, from: { user: { displayName } },
 *                   mentions: [ { mentioned: { user: { displayName } } } ],
 *                   replies: [ <same message shape> ] } ] }
 *
 * The grouping key (channelId) lives on the ENVELOPE, not the message. So this
 * collector consumes an ARRAY OF CHANNEL ENVELOPES and threads channelId onto
 * each message's events. Replies are nested under root messages and are ALSO
 * activity — this collector processes root messages AND their replies
 * identically (a reply's sender helped the channel / the reply's mentions).
 * Identity is a display NAME; the crew reference's aliases[] map it to the
 * canonical member username.
 *
 * Crew tagging: source crew = sender's crew (displayName → member → crew);
 * target crew = the channel's owning crew (mapping type `channel`).
 *
 * Same wiring model as the other collectors: raw Teams data arrives as method
 * arguments (CEL-wired); this stays a pure translation function.
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
// Upstream shape contract — @webframp/microsoft/teams channelMessages envelope.
// Only the fields this collector reads are declared; extras (teamId,
// channelName, body, etc.) are ignored on parse.
// =============================================================================

const TeamsMentionSchema = z.object({
  mentioned: z.object({
    user: z.object({
      id: z.string().default(""),
      displayName: z.string().nullable().optional(),
    }).optional(),
  }).optional(),
});

const TeamsFromSchema = z.object({
  user: z.object({
    id: z.string().optional(),
    displayName: z.string().nullable().optional(),
  }).nullable().optional(),
}).default({});

// A reply has the same sender/mention/time shape as a root message but no
// further nesting (Teams is one level of replies).
const TeamsReplySchema = z.object({
  id: z.string(),
  createdDateTime: z.string().default(""),
  from: TeamsFromSchema,
  mentions: z.array(TeamsMentionSchema).default([]),
});

const TeamsMessageSchema = z.object({
  id: z.string(),
  createdDateTime: z.string().default(""),
  from: TeamsFromSchema,
  mentions: z.array(TeamsMentionSchema).default([]),
  replies: z.array(TeamsReplySchema).optional(),
});

/** One `channelMessages` result envelope: a channel plus its messages. */
const TeamsChannelMessagesSchema = z.object({
  channelId: z.string().describe("Channel id — the crew mapping key"),
  messages: z.array(TeamsMessageSchema).default([]),
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
  source: z.literal("teams"),
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
  channelCrew: (channelId: string) => string;
  canonical: (raw: string) => string;
} {
  const byUser = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const m of ref.members) {
    byUser.set(m.username, m.crewId);
    aliases.set(m.username, m.username);
    for (const a of m.aliases ?? []) aliases.set(a, m.username);
  }
  const byChannel = new Map<string, string>();
  for (const m of ref.mappings) {
    if (m.mappingType === "channel") byChannel.set(m.value, m.crewId);
  }
  const canonical = (raw: string) => canonicalActor(raw, aliases);
  return {
    userCrew: (u: string) => byUser.get(canonical(u)) ?? "",
    channelCrew: (c: string) => byChannel.get(c) ?? "",
    canonical,
  };
}

type SyncArgs = {
  channels: z.infer<typeof TeamsChannelMessagesSchema>[];
  crewReference: CrewReference;
};
type TranslateResult = { events: Event[]; unresolvedCrews: number };
type Msg =
  | z.infer<typeof TeamsMessageSchema>
  | z.infer<typeof TeamsReplySchema>;

/**
 * Translate Teams channel activity into uniform cross-boundary events: a member
 * from one crew who answers a message in another crew's channel helped that
 * crew. Pure function — this collector's anti-corruption layer.
 */
export function translate(args: SyncArgs): TranslateResult {
  const { userCrew, channelCrew, canonical } = buildLookups(args.crewReference);
  const events: Event[] = [];
  let unresolvedCrews = 0;

  // Process one message (root OR reply) identically. Returns whether the
  // message's crews were unresolved so the caller can count DR-5 once.
  const processMessage = (
    msg: Msg,
    channelId: string,
    targetCrew: string,
  ): void => {
    const rawSender = msg.from.user?.displayName ?? "";
    if (rawSender === "") return; // system message, no author
    const sender = canonical(rawSender);
    const sourceCrew = userCrew(rawSender);
    if (sourceCrew === "" || targetCrew === "") unresolvedCrews++;

    // Resolve mentioned users; each is a helped user. A message with no
    // mentions is still activity to the channel's crew (targetUser empty).
    const mentioned = msg.mentions
      .map((m) => m.mentioned?.user?.displayName ?? "")
      .filter((n) => n !== "")
      .map((n) => canonical(n))
      .filter((n) => n !== sender);

    if (mentioned.length === 0) {
      events.push(
        newEvent(
          {
            userId: sender,
            username: sender,
            eventType: "teams_message",
            sourceCrew,
            targetCrew,
            targetUser: "",
            projectId: channelId,
            timestamp: msg.createdDateTime,
          },
          [channelId, msg.id, "teams_message"],
        ),
      );
    } else {
      for (const target of mentioned) {
        events.push(
          newEvent(
            {
              userId: sender,
              username: sender,
              eventType: "teams_message",
              sourceCrew,
              targetCrew,
              targetUser: target,
              projectId: channelId,
              timestamp: msg.createdDateTime,
            },
            // Identity includes the mention target so distinct mentions in
            // one message are distinct events.
            [channelId, msg.id, target, "teams_message"],
          ),
        );
      }
    }
  };

  for (const ch of args.channels) {
    const targetCrew = channelCrew(ch.channelId);
    for (const msg of ch.messages) {
      processMessage(msg, ch.channelId, targetCrew);
      // Replies are activity too — the reply's sender helped the channel.
      for (const reply of msg.replies ?? []) {
        processMessage(reply, ch.channelId, targetCrew);
      }
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

/** Teams collector model — translates channel messages into events. */
export const model = {
  type: "@webframp/devops-measurement/collect-teams",
  version: "2026.09.01.1",
  upgrades: [],
  globalArguments: GlobalArgsSchema,

  resources: {
    events: {
      description: "Events translated from Teams channel messages",
      schema: EventBatchSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    sync: {
      description:
        "Translate Teams channel messages (from @webframp/microsoft/teams, " +
        "wired via CEL) into teams_message events. Fan-out over all channels. " +
        "Sender helps the channel's crew; @mentions become helped users. " +
        "Reports unresolvedCrews.",
      arguments: z.object({
        channels: z.array(TeamsChannelMessagesSchema).default([]).describe(
          "Array of @webframp/microsoft/teams channelMessages envelopes (each " +
            "{ channelId, messages[] } with nested replies). Wire via CEL from " +
            "each channelMessages instance's data.latest.",
        ),
        crewReference: CrewReferenceSchema.describe("Crew reference via CEL"),
      }),
      execute: async (args: SyncArgs, context: MethodContext) => {
        const startMs = Date.now();
        const { events, unresolvedCrews } = translate(args);

        const handle = await context.writeResource("events", "teams-events", {
          events,
          count: events.length,
          unresolvedCrews,
          source: "teams",
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });

        if (unresolvedCrews > 0) {
          context.logger.warn(
            "Teams collector: {n} activities with unresolved crews",
            { n: unresolvedCrews },
          );
        }
        context.logger.info("Teams collector: {count} events", {
          count: events.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
