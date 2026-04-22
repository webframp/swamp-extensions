// Twitch Moderation Model
// Provides methods for channel info, chatters, user lookup, bans, and mod events.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { helixApi, helixApiPaginated } from "./_lib/api.ts";
import type { TwitchCredentials } from "./_lib/types.ts";

// =============================================================================
// Helpers (internal)
// =============================================================================

interface GlobalArgs {
  channel: string;
  moderatorId: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
}

function credsFrom(globalArgs: GlobalArgs): TwitchCredentials {
  return {
    clientId: globalArgs.clientId,
    clientSecret: globalArgs.clientSecret,
    accessToken: globalArgs.accessToken,
    refreshToken: globalArgs.refreshToken,
  };
}

async function getBroadcasterId(
  creds: TwitchCredentials,
  channel: string,
): Promise<string> {
  const resp = await helixApi<{
    id: string;
    login: string;
  }>(creds, `/users?login=${encodeURIComponent(channel)}`);
  if (resp.data.length === 0) {
    throw new Error(`Twitch user not found for channel: ${channel}`);
  }
  return resp.data[0].id;
}

// =============================================================================
// Context type shorthand
// =============================================================================

type MethodContext = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  channel: z.string().describe("Twitch channel login name"),
  moderatorId: z.string().describe(
    "Your Twitch user ID (the moderator performing actions)",
  ),
  clientId: z.string().meta({ sensitive: true }).describe(
    "Twitch application client ID",
  ),
  clientSecret: z.string().meta({ sensitive: true }).describe(
    "Twitch application client secret",
  ),
  accessToken: z.string().meta({ sensitive: true }).describe(
    "OAuth2 access token",
  ),
  refreshToken: z.string().meta({ sensitive: true }).describe(
    "OAuth2 refresh token",
  ),
});

const ChannelSchema = z.object({
  broadcasterId: z.string(),
  broadcasterLogin: z.string(),
  broadcasterName: z.string(),
  gameName: z.string(),
  gameId: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  fetchedAt: z.string(),
});

const ChatterSchema = z.object({
  userId: z.string(),
  login: z.string(),
  displayName: z.string(),
});

const ChattersSchema = z.object({
  channel: z.string(),
  chatters: z.array(ChatterSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const UserSchema = z.object({
  userId: z.string(),
  login: z.string(),
  displayName: z.string(),
  accountCreatedAt: z.string(),
  accountAgeDays: z.number(),
  profileImageUrl: z.string(),
  broadcasterType: z.string(),
  fetchedAt: z.string(),
});

const BanEntrySchema = z.object({
  userId: z.string(),
  login: z.string(),
  reason: z.string(),
  moderatorLogin: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});

const BannedUsersSchema = z.object({
  channel: z.string(),
  bans: z.array(BanEntrySchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const BanResultSchema = z.object({
  action: z.string(),
  userId: z.string(),
  channel: z.string(),
  fetchedAt: z.string(),
});

const ModEventSchema = z.object({
  eventType: z.string(),
  eventTimestamp: z.string(),
  userId: z.string(),
  userLogin: z.string(),
  channelLogin: z.string(),
});

const ModEventsSchema = z.object({
  channel: z.string(),
  events: z.array(ModEventSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

// =============================================================================
// Model Definition
// =============================================================================

export const model = {
  type: "@webframp/twitch",
  version: "2026.04.22.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    "channel": {
      description: "Channel information for a broadcaster",
      schema: ChannelSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "chatters": {
      description: "Current chatters in a channel",
      schema: ChattersSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "user": {
      description: "Twitch user profile and account age",
      schema: UserSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "banned-users": {
      description: "Banned users in a channel",
      schema: BannedUsersSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "ban-result": {
      description: "Result of a ban, unban, or timeout action",
      schema: BanResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "mod-events": {
      description: "Moderator add/remove events in a channel",
      schema: ModEventsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    get_channel: {
      description:
        "Get channel information (game, title, tags) for the configured channel",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { channel } = context.globalArgs;
        const creds = credsFrom(context.globalArgs);
        const broadcasterId = await getBroadcasterId(creds, channel);

        const resp = await helixApi<{
          broadcaster_id: string;
          broadcaster_login: string;
          broadcaster_name: string;
          game_name: string;
          game_id: string;
          title: string;
          tags: string[];
        }>(creds, `/channels?broadcaster_id=${broadcasterId}`);

        if (resp.data.length === 0) {
          throw new Error(
            `Channel info not found for broadcaster: ${broadcasterId}`,
          );
        }
        const ch = resp.data[0];
        const handle = await context.writeResource("channel", channel, {
          broadcasterId: ch.broadcaster_id,
          broadcasterLogin: ch.broadcaster_login,
          broadcasterName: ch.broadcaster_name,
          gameName: ch.game_name,
          gameId: ch.game_id,
          title: ch.title,
          tags: ch.tags ?? [],
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Fetched channel info for {channel}", { channel });
        return { dataHandles: [handle] };
      },
    },

    get_chatters: {
      description: "Get the list of current chatters in the configured channel",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { channel, moderatorId } = context.globalArgs;
        const creds = credsFrom(context.globalArgs);
        const broadcasterId = await getBroadcasterId(creds, channel);

        const raw = await helixApiPaginated<{
          user_id: string;
          user_login: string;
          user_name: string;
        }>(
          creds,
          `/chat/chatters?broadcaster_id=${broadcasterId}&moderator_id=${
            encodeURIComponent(moderatorId)
          }`,
        );

        const chatters = raw.map((c) => ({
          userId: c.user_id,
          login: c.user_login,
          displayName: c.user_name,
        }));

        const handle = await context.writeResource("chatters", channel, {
          channel,
          chatters,
          count: chatters.length,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} chatters in {channel}", {
          count: chatters.length,
          channel,
        });
        return { dataHandles: [handle] };
      },
    },

    get_user: {
      description:
        "Look up a Twitch user by login and compute account age in days",
      arguments: z.object({
        login: z.string().describe("Twitch login name to look up"),
      }),
      execute: async (args: { login: string }, context: MethodContext) => {
        const creds = credsFrom(context.globalArgs);

        const resp = await helixApi<{
          id: string;
          login: string;
          display_name: string;
          created_at: string;
          profile_image_url: string;
          broadcaster_type: string;
        }>(creds, `/users?login=${encodeURIComponent(args.login)}`);

        if (resp.data.length === 0) {
          throw new Error(`Twitch user not found: ${args.login}`);
        }

        const u = resp.data[0];
        const createdDate = new Date(u.created_at);
        const accountAgeDays = Math.floor(
          (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24),
        );

        const handle = await context.writeResource("user", args.login, {
          userId: u.id,
          login: u.login,
          displayName: u.display_name,
          accountCreatedAt: u.created_at,
          accountAgeDays,
          profileImageUrl: u.profile_image_url,
          broadcasterType: u.broadcaster_type,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Fetched user {login} (account age: {days} days)", {
          login: u.login,
          days: accountAgeDays,
        });
        return { dataHandles: [handle] };
      },
    },

    get_banned_users: {
      description: "Get all banned users in the configured channel",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { channel } = context.globalArgs;
        const creds = credsFrom(context.globalArgs);
        const broadcasterId = await getBroadcasterId(creds, channel);

        const raw = await helixApiPaginated<{
          user_id: string;
          user_login: string;
          reason: string;
          moderator_login: string;
          created_at: string;
          expires_at: string;
        }>(creds, `/moderation/banned?broadcaster_id=${broadcasterId}`);

        const bans = raw.map((b) => ({
          userId: b.user_id,
          login: b.user_login,
          reason: b.reason,
          moderatorLogin: b.moderator_login,
          createdAt: b.created_at,
          expiresAt: b.expires_at === "" ? null : b.expires_at,
        }));

        const handle = await context.writeResource("banned-users", channel, {
          channel,
          bans,
          count: bans.length,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} bans in {channel}", {
          count: bans.length,
          channel,
        });
        return { dataHandles: [handle] };
      },
    },

    ban_user: {
      description:
        "Ban or timeout a user in the configured channel. Omit duration for a permanent ban.",
      arguments: z.object({
        userId: z.string().describe("Twitch user ID to ban"),
        reason: z.string().optional().describe("Reason for the ban"),
        duration: z.number().optional().describe(
          "Timeout duration in seconds (omit for permanent ban)",
        ),
      }),
      execute: async (
        args: { userId: string; reason?: string; duration?: number },
        context: MethodContext,
      ) => {
        const { channel, moderatorId } = context.globalArgs;
        const creds = credsFrom(context.globalArgs);
        const broadcasterId = await getBroadcasterId(creds, channel);

        const banData: Record<string, unknown> = { user_id: args.userId };
        if (args.reason !== undefined) banData.reason = args.reason;
        if (args.duration !== undefined) banData.duration = args.duration;

        await helixApi(
          creds,
          `/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${
            encodeURIComponent(moderatorId)
          }`,
          "POST",
          { data: banData },
        );

        const action = args.duration !== undefined ? "timeout" : "ban";

        const handle = await context.writeResource("ban-result", args.userId, {
          action,
          userId: args.userId,
          channel,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("{action} user {userId} in {channel}", {
          action,
          userId: args.userId,
          channel,
        });
        return { dataHandles: [handle] };
      },
    },

    unban_user: {
      description:
        "Remove a ban or timeout for a user in the configured channel",
      arguments: z.object({
        userId: z.string().describe("Twitch user ID to unban"),
      }),
      execute: async (args: { userId: string }, context: MethodContext) => {
        const { channel, moderatorId } = context.globalArgs;
        const creds = credsFrom(context.globalArgs);
        const broadcasterId = await getBroadcasterId(creds, channel);

        await helixApi(
          creds,
          `/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${
            encodeURIComponent(moderatorId)
          }&user_id=${args.userId}`,
          "DELETE",
        );

        const handle = await context.writeResource("ban-result", args.userId, {
          action: "unban",
          userId: args.userId,
          channel,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Unbanned user {userId} in {channel}", {
          userId: args.userId,
          channel,
        });
        return { dataHandles: [handle] };
      },
    },

    get_mod_events: {
      description: "Get moderator add/remove events for the configured channel",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { channel } = context.globalArgs;
        const creds = credsFrom(context.globalArgs);
        const broadcasterId = await getBroadcasterId(creds, channel);

        const raw = await helixApiPaginated<{
          event_type: string;
          event_timestamp: string;
          event_data: {
            user_id: string;
            user_login: string;
            broadcaster_login: string;
          };
        }>(
          creds,
          `/moderation/moderators/events?broadcaster_id=${broadcasterId}`,
        );

        const events = raw.map((e) => ({
          eventType: e.event_type,
          eventTimestamp: e.event_timestamp,
          userId: e.event_data.user_id,
          userLogin: e.event_data.user_login,
          channelLogin: e.event_data.broadcaster_login,
        }));

        const handle = await context.writeResource("mod-events", channel, {
          channel,
          events,
          count: events.length,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} mod events in {channel}", {
          count: events.length,
          channel,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
