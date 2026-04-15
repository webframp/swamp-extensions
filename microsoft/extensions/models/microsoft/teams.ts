// Microsoft Teams Model
// Surfaces Teams chats, channel messages, and @mentions via Graph API.
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { z } from "npm:zod@4";
import { refreshAccessToken } from "./_lib/auth.ts";
import { graphRequest, graphRequestPaginated } from "./_lib/graph.ts";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  tenantId: z.string().meta({ sensitive: true }).describe(
    "Entra tenant GUID or domain (e.g. contoso.onmicrosoft.com)",
  ),
  clientId: z.string().meta({ sensitive: true }).describe(
    "Azure app registration client ID",
  ),
  clientSecret: z.string().meta({ sensitive: true }).describe(
    "Azure app registration client secret",
  ),
  refreshToken: z.string().meta({ sensitive: true }).describe(
    "OAuth2 refresh token obtained via bootstrap. Re-run bootstrap if expired.",
  ),
});

const ChatSchema = z.object({
  id: z.string(),
  chatType: z.string(),
  topic: z.string().nullable().optional(),
  createdDateTime: z.string(),
  lastUpdatedDateTime: z.string(),
  webUrl: z.string().optional(),
  members: z.array(
    z.object({
      id: z.string(),
      displayName: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    }),
  ).optional(),
});

const ChatMessageBodySchema = z.object({
  contentType: z.string(),
  content: z.string(),
});

const ChatMessageSchema = z.object({
  id: z.string(),
  messageType: z.string(),
  createdDateTime: z.string(),
  lastModifiedDateTime: z.string().optional(),
  deletedDateTime: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  importance: z.string(),
  body: ChatMessageBodySchema,
  from: z.object({
    user: z.object({
      id: z.string(),
      displayName: z.string().nullable().optional(),
      userIdentityType: z.string().optional(),
    }).nullable().optional(),
  }).nullable().optional(),
  mentions: z.array(
    z.object({
      id: z.number(),
      mentionText: z.string(),
      mentioned: z.object({
        user: z.object({
          id: z.string(),
          displayName: z.string().nullable().optional(),
        }).optional(),
      }).optional(),
    }),
  ).optional(),
  webUrl: z.string().nullable().optional(),
  chatId: z.string().optional(),
  channelIdentity: z.object({
    teamId: z.string(),
    channelId: z.string(),
  }).optional(),
});

const TeamSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().nullable().optional(),
  webUrl: z.string().optional(),
});

const ChannelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().nullable().optional(),
  membershipType: z.string(),
  webUrl: z.string().optional(),
});

const ChatListSchema = z.object({
  chats: z.array(ChatSchema),
  totalFetched: z.number(),
  fetchedAt: z.string(),
});

const ChatMessagesSchema = z.object({
  chatId: z.string(),
  messages: z.array(ChatMessageSchema),
  totalFetched: z.number(),
  fetchedAt: z.string(),
});

const ChannelMessagesSchema = z.object({
  teamId: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  messages: z.array(ChatMessageSchema),
  totalFetched: z.number(),
  fetchedAt: z.string(),
});

const MentionsSchema = z.object({
  messages: z.array(ChatMessageSchema),
  totalFetched: z.number(),
  fetchedAt: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

async function getAccessToken(
  globalArgs: z.infer<typeof GlobalArgsSchema>,
): Promise<string> {
  const tokens = await refreshAccessToken({
    tenantId: globalArgs.tenantId,
    clientId: globalArgs.clientId,
    clientSecret: globalArgs.clientSecret,
    refreshToken: globalArgs.refreshToken,
  });
  return tokens.access_token;
}

// =============================================================================
// Model Definition
// =============================================================================

export const model = {
  type: "@webframp/microsoft/teams",
  version: "2026.04.15.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    chats: {
      description: "List of Teams chats the signed-in user participates in",
      schema: ChatListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    chatMessages: {
      description: "Messages from a specific Teams chat",
      schema: ChatMessagesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    channelMessages: {
      description: "Messages from a Teams channel",
      schema: ChannelMessagesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    mentions: {
      description: "Messages that @mention the signed-in user",
      schema: MentionsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    list_chats: {
      description:
        "List Teams chats the signed-in user participates in, with member details",
      arguments: z.object({
        top: z.number().int().min(1).max(50).default(20).describe(
          "Maximum number of chats to fetch",
        ),
        includeMembers: z.boolean().default(true).describe(
          "Expand member list on each chat",
        ),
      }),
      execute: async (
        args: { top: number; includeMembers: boolean },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const accessToken = await getAccessToken(context.globalArgs);

        const params: Record<string, string> = {
          "$top": String(args.top),
          "$orderby": "lastUpdatedDateTime desc",
          "$select":
            "id,chatType,topic,createdDateTime,lastUpdatedDateTime,webUrl",
        };

        if (args.includeMembers) {
          params["$expand"] = "members($select=id,displayName,email)";
        }

        const chats = await graphRequestPaginated<z.infer<typeof ChatSchema>>(
          accessToken,
          "/me/chats",
          params,
        );

        const handle = await context.writeResource("chats", "main", {
          chats,
          totalFetched: chats.length,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Fetched {count} chats", { count: chats.length });
        return { dataHandles: [handle] };
      },
    },

    get_chat_messages: {
      description: "Fetch messages from a specific Teams chat",
      arguments: z.object({
        chatId: z.string().describe("Teams chat ID"),
        top: z.number().int().min(1).max(100).default(50).describe(
          "Maximum messages to fetch",
        ),
      }),
      execute: async (
        args: { chatId: string; top: number },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const accessToken = await getAccessToken(context.globalArgs);

        const messages = await graphRequestPaginated<
          z.infer<typeof ChatMessageSchema>
        >(
          accessToken,
          `/me/chats/${args.chatId}/messages`,
          {
            "$top": String(args.top),
            "$select": "id,messageType,createdDateTime,lastModifiedDateTime," +
              "deletedDateTime,subject,importance,body,from,mentions,webUrl,chatId",
          },
        );

        // Filter out system messages (memberAdded, etc.)
        const userMessages = messages.filter(
          (m) => m.messageType === "message",
        );

        const handle = await context.writeResource(
          "chatMessages",
          args.chatId,
          {
            chatId: args.chatId,
            messages: userMessages,
            totalFetched: userMessages.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Fetched {count} messages from chat {id}",
          { count: userMessages.length, id: args.chatId },
        );

        return { dataHandles: [handle] };
      },
    },

    list_channel_messages: {
      description: "Fetch messages from a Teams channel. " +
        "NOTE: requires ChannelMessage.Read.All delegated scope (admin consent) and " +
        "Channel.ReadBasic.All — these are not included in the default minimal scope set " +
        "for security reasons. This method will return a 403 unless those scopes are " +
        "explicitly granted on the app registration. Use get_chat_messages for 1:1 and " +
        "group chats instead, which works with the default Chat.Read scope.",
      arguments: z.object({
        teamId: z.string().describe("Teams team ID"),
        channelId: z.string().describe("Teams channel ID"),
        top: z.number().int().min(1).max(100).default(50).describe(
          "Maximum messages to fetch",
        ),
      }),
      execute: async (
        args: { teamId: string; channelId: string; top: number },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const accessToken = await getAccessToken(context.globalArgs);

        // Fetch channel name for display.
        const channel = await graphRequest<z.infer<typeof ChannelSchema>>(
          accessToken,
          "GET",
          `/teams/${args.teamId}/channels/${args.channelId}`,
        );

        const messages = await graphRequestPaginated<
          z.infer<typeof ChatMessageSchema>
        >(
          accessToken,
          `/teams/${args.teamId}/channels/${args.channelId}/messages`,
          {
            "$top": String(args.top),
            "$select": "id,messageType,createdDateTime,lastModifiedDateTime," +
              "deletedDateTime,subject,importance,body,from,mentions,webUrl,channelIdentity",
          },
        );

        const userMessages = messages.filter(
          (m) => m.messageType === "message",
        );

        const instanceId = `${args.teamId}__${args.channelId}`;
        const handle = await context.writeResource(
          "channelMessages",
          instanceId,
          {
            teamId: args.teamId,
            channelId: args.channelId,
            channelName: channel.displayName,
            messages: userMessages,
            totalFetched: userMessages.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Fetched {count} messages from channel {channel}",
          { count: userMessages.length, channel: channel.displayName },
        );

        return { dataHandles: [handle] };
      },
    },

    get_mentions: {
      description:
        "Fetch Teams messages that @mention the signed-in user across all chats",
      arguments: z.object({
        top: z.number().int().min(1).max(100).default(50).describe(
          "Maximum mentions to return (across all chats)",
        ),
      }),
      execute: async (
        args: { top: number },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const accessToken = await getAccessToken(context.globalArgs);

        // The Graph API exposes /me/chats/getAllMessages for cross-chat queries.
        // Filter to messages containing at least one @mention.
        const messages = await graphRequestPaginated<
          z.infer<typeof ChatMessageSchema>
        >(
          accessToken,
          "/me/chats/getAllMessages",
          {
            "$top": String(args.top),
            "$filter": "mentions/any(m: m/mentioned/user/id eq @me)",
            "$select":
              "id,messageType,createdDateTime,subject,importance,body,from,mentions,webUrl,chatId",
          },
        );

        const userMessages = messages.filter(
          (m) => m.messageType === "message",
        );

        const handle = await context.writeResource("mentions", "main", {
          messages: userMessages,
          totalFetched: userMessages.length,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info(
          "Found {count} messages mentioning you",
          { count: userMessages.length },
        );

        return { dataHandles: [handle] };
      },
    },

    list_teams: {
      description: "List Teams the signed-in user is a member of. " +
        "NOTE: requires Team.ReadBasic.All delegated scope — not included in the default " +
        "minimal scope set for security reasons (tenant-wide read). This method will return " +
        "a 403 unless that scope is explicitly granted on the app registration.",
      arguments: z.object({}),
      execute: async (
        _args: Record<never, never>,
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const accessToken = await getAccessToken(context.globalArgs);

        const teams = await graphRequestPaginated<z.infer<typeof TeamSchema>>(
          accessToken,
          "/me/joinedTeams",
          {
            "$select": "id,displayName,description,webUrl",
          },
        );

        // Write each team as a separate factory instance so CEL can reference
        // individual teams by name.
        const handles = await Promise.all(
          teams.map((team) =>
            context.writeResource("chats", team.id, {
              chats: [],
              totalFetched: 0,
              fetchedAt: new Date().toISOString(),
              // Store team metadata in a compatible shape.
              _teamMetadata: team,
            })
          ),
        );

        context.logger.info(
          "Found {count} joined teams",
          { count: teams.length },
        );

        return { dataHandles: handles };
      },
    },
  },
};
