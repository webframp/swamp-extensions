/**
 * Microsoft Teams Model — read-only access to Teams channels, chats, and mentions.
 *
 * Uses the appsvc_teams_data_client public client app registration with delegated
 * permissions via device code flow. No client secret required.
 *
 * @module
 */
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { z } from "npm:zod@4.4.3";
import {
  initiateDeviceCode,
  pollDeviceCode,
  refreshAccessToken,
} from "./_lib/auth.ts";
import { graphRequest, graphRequestPaginated } from "./_lib/graph.ts";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  tenantId: z.string().min(1).describe(
    "Entra tenant GUID (e.g. e9b2b7ba-b238-42a9-b271-2adfc82da650)",
  ),
  clientId: z.string().min(1).describe(
    "Azure public client app registration ID",
  ),
  refreshToken: z.string().min(1).meta({ sensitive: true }).describe(
    "OAuth2 refresh token obtained via bootstrap. Re-run bootstrap if expired.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const TeamSchema = z.object({
  id: z.string().describe("Team ID"),
  displayName: z.string().describe("Team display name"),
  description: z.string().nullable().optional().describe("Team description"),
});

const TeamsListSchema = z.object({
  teams: z.array(TeamSchema).describe(
    "Teams the signed-in user is a member of",
  ),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
});

const ChannelSchema = z.object({
  id: z.string().describe("Channel ID"),
  displayName: z.string().describe("Channel display name"),
  description: z.string().nullable().optional().describe(
    "Channel description",
  ),
  membershipType: z.string().optional().describe(
    "Channel membership type (e.g. standard, private, shared)",
  ),
});

const ChannelsListSchema = z.object({
  teamId: z.string().describe("Team the channels belong to"),
  teamName: z.string().describe("Display name of the team"),
  channels: z.array(ChannelSchema).describe("Channels in the team"),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
});

const MessageFromSchema = z.object({
  user: z.object({
    id: z.string().optional().describe("Sender's user ID"),
    displayName: z.string().nullable().optional().describe(
      "Sender's display name",
    ),
  }).nullable().optional().describe("Sending user, null for system messages"),
}).nullable().optional();

const MentionSchema = z.object({
  id: z.number().describe("Mention index within the message"),
  mentionText: z.string().optional().describe("Rendered mention text"),
  mentioned: z.object({
    user: z.object({
      id: z.string().describe("Mentioned user's ID"),
      displayName: z.string().nullable().optional().describe(
        "Mentioned user's display name",
      ),
    }).optional(),
  }).optional().describe("The user mentioned"),
});

const ReplySchema = z.object({
  id: z.string().describe("Reply message ID"),
  createdDateTime: z.string().describe("Timestamp the reply was created"),
  lastModifiedDateTime: z.string().nullable().optional().describe(
    "Timestamp the reply was last modified",
  ),
  subject: z.string().nullable().optional().describe("Reply subject line"),
  body: z.object({
    contentType: z.string().describe("Content type (text or html)"),
    content: z.string().describe("Message body content"),
  }).describe("Reply body"),
  from: MessageFromSchema,
  importance: z.string().optional().describe("Message importance level"),
  webUrl: z.string().nullable().optional().describe("Web URL for the reply"),
  mentions: z.array(MentionSchema).optional().describe(
    "@mentions in the reply",
  ),
});

const MessageSchema = z.object({
  id: z.string().describe("Message ID"),
  createdDateTime: z.string().describe("Timestamp the message was created"),
  lastModifiedDateTime: z.string().nullable().optional().describe(
    "Timestamp the message was last modified",
  ),
  subject: z.string().nullable().optional().describe("Message subject line"),
  body: z.object({
    contentType: z.string().describe("Content type (text or html)"),
    content: z.string().describe("Message body content"),
  }).describe("Message body"),
  from: MessageFromSchema,
  importance: z.string().optional().describe("Message importance level"),
  webUrl: z.string().nullable().optional().describe("Web URL for the message"),
  mentions: z.array(MentionSchema).optional().describe(
    "@mentions in the message",
  ),
  replies: z.array(ReplySchema).optional().describe(
    "Replies nested under this root message",
  ),
});

const ChannelMessagesSchema = z.object({
  teamId: z.string().describe("Team the channel belongs to"),
  channelId: z.string().describe("Channel the messages belong to"),
  channelName: z.string().describe("Display name of the channel"),
  messages: z.array(MessageSchema).describe(
    "Root messages, with replies nested when requested",
  ),
  totalRoots: z.number().describe("Number of root messages returned"),
  truncated: z.boolean().describe(
    "Whether the fetch hit the limit or page cap before exhausting the channel",
  ),
  fetchedAt: z.string().describe("Timestamp the messages were fetched"),
});

const ChatMemberSchema = z.object({
  displayName: z.string().nullable().optional().describe(
    "Member's display name",
  ),
  email: z.string().nullable().optional().describe("Member's email address"),
  userId: z.string().optional().describe("Member's user ID"),
});

const ChatViewpointSchema = z.object({
  isHidden: z.boolean().optional().describe(
    "Whether the chat is hidden for the signed-in user",
  ),
  lastMessageReadDateTime: z.string().nullable().optional().describe(
    "Timestamp of the last message the signed-in user read",
  ),
});

const ChatSchema = z.object({
  id: z.string().describe("Chat ID"),
  chatType: z.string().optional().describe(
    "Chat type (oneOnOne, group, meeting)",
  ),
  topic: z.string().nullable().optional().describe("Chat topic/title"),
  createdDateTime: z.string().optional().describe(
    "Timestamp the chat was created",
  ),
  lastUpdatedDateTime: z.string().nullable().optional().describe(
    "Timestamp of the chat's last activity",
  ),
  webUrl: z.string().optional().describe("Web URL for the chat"),
  members: z.array(ChatMemberSchema).optional().describe("Chat members"),
  viewpoint: ChatViewpointSchema.nullable().optional().describe(
    "Signed-in user's read state for this chat",
  ),
});

const ChatsListSchema = z.object({
  chats: z.array(ChatSchema).describe(
    "Chats the signed-in user participates in",
  ),
  totalFetched: z.number().describe("Number of chats returned"),
  truncated: z.boolean().describe(
    "Whether the fetch hit the limit or page cap before exhausting the list",
  ),
  fetchedAt: z.string().describe("Timestamp the list was fetched"),
});

const ChatMessagesSchema = z.object({
  chatId: z.string().describe("Chat the messages belong to"),
  messages: z.array(MessageSchema).describe("Messages returned, newest first"),
  totalFetched: z.number().describe("Number of messages returned"),
  truncated: z.boolean().describe(
    "Whether the fetch hit the limit before exhausting the chat",
  ),
  fetchedAt: z.string().describe("Timestamp the messages were fetched"),
});

const AttentionItemSchema = z.object({
  reason: z.enum(["mention", "unread_chat"]).describe(
    "Why this item needs attention",
  ),
  when: z.string().describe("Timestamp of the triggering event"),
  chatLabel: z.string().describe("Human-readable label for the chat"),
  chat: ChatSchema.describe("The chat this item belongs to"),
  message: MessageSchema.optional().describe(
    "The mentioning message, present only when reason is mention",
  ),
});

const AttentionSchema = z.object({
  items: z.array(AttentionItemSchema).describe(
    "Attention items, sorted newest first",
  ),
  totalItems: z.number().describe("Number of attention items returned"),
  truncated: z.boolean().describe(
    "Whether the chat scan hit chatLimit before exhausting the list",
  ),
  since: z.string().describe("Timestamp the lookback window started"),
  fetchedAt: z.string().describe("Timestamp the aggregation ran"),
});

const BootstrapResultSchema = z.object({
  status: z.string().describe("Authentication result status"),
  message: z.string().describe("Human-readable guidance for the caller"),
  refreshToken: z.string().meta({ sensitive: true }).optional().describe(
    "OAuth2 refresh token to store in the vault",
  ),
});

// =============================================================================
// Helpers
// =============================================================================

async function getAccessToken(globalArgs: GlobalArgs): Promise<string> {
  const tokens = await refreshAccessToken({
    tenantId: globalArgs.tenantId,
    clientId: globalArgs.clientId,
    refreshToken: globalArgs.refreshToken,
  });
  return tokens.access_token;
}

interface GraphTeam {
  id: string;
  displayName: string;
  description?: string | null;
}

interface GraphChannel {
  id: string;
  displayName: string;
  description?: string | null;
  membershipType?: string;
}

interface GraphMessage {
  id: string;
  messageType?: string;
  createdDateTime: string;
  lastModifiedDateTime?: string | null;
  subject?: string | null;
  body: { contentType: string; content: string };
  from?: { user?: { id?: string; displayName?: string | null } | null } | null;
  importance?: string;
  webUrl?: string | null;
  mentions?: Array<{
    id: number;
    mentionText?: string;
    mentioned?: { user?: { id: string; displayName?: string | null } };
  }>;
  replyToId?: string | null;
}

interface GraphChat {
  id: string;
  chatType?: string;
  topic?: string | null;
  createdDateTime?: string;
  lastUpdatedDateTime?: string | null;
  webUrl?: string;
  members?: Array<{
    displayName?: string | null;
    email?: string | null;
    userId?: string;
  }>;
  viewpoint?: {
    isHidden?: boolean;
    lastMessageReadDateTime?: string | null;
  } | null;
}

interface GraphUser {
  id: string;
  displayName?: string;
}

interface GraphPagedResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

const MAX_CHANNEL_PAGES = 5;

function chatLabel(ch: GraphChat): string {
  if (ch.topic) return ch.topic;
  const names = (ch.members ?? [])
    .map((m) => m.displayName)
    .filter(Boolean) as string[];
  const prefix = `(${ch.chatType ?? "unknown"}) `;
  if (names.length === 0) return prefix + "-";
  if (names.length <= 3) return prefix + names.join(", ");
  return prefix + `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

// =============================================================================
// Model Definition
// =============================================================================

/** Microsoft Teams read-only model via Graph API. */
export const model = {
  type: "@webframp/microsoft/teams",
  version: "2026.08.21.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.18.2",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.20.1",
      description: "Pin zod to 4.4.3 — no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.1",
      description:
        "No schema changes (added field descriptions and required-string min-length checks)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    teams: {
      description: "Teams the signed-in user is a member of",
      schema: TeamsListSchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
    channels: {
      description: "Channels in a team",
      schema: ChannelsListSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    channelMessages: {
      description:
        "Threaded messages from a Teams channel (roots with nested replies)",
      schema: ChannelMessagesSchema,
      lifetime: "15m" as const,
      garbageCollection: 20,
    },
    chats: {
      description: "Teams chats the signed-in user participates in",
      schema: ChatsListSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    chatMessages: {
      description: "Messages from a specific Teams chat",
      schema: ChatMessagesSchema,
      lifetime: "15m" as const,
      garbageCollection: 20,
    },
    attention: {
      description: "Aggregated attention items: unread chats and @mentions",
      schema: AttentionSchema,
      lifetime: "15m" as const,
      garbageCollection: 10,
    },
    bootstrap: {
      description: "Device code flow authentication result",
      schema: BootstrapResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },

  methods: {
    bootstrap: {
      description:
        "Authenticate via device code flow. Displays a user code and " +
        "verification URL, then polls until authentication completes. " +
        "Outputs the refresh token to store in the vault.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { tenantId, clientId } = context.globalArgs;

        const deviceCode = await initiateDeviceCode(tenantId, clientId);

        context.logger.info(
          "Device code flow initiated. Go to {uri} and enter code: {code}",
          { uri: deviceCode.verification_uri, code: deviceCode.user_code },
        );

        const tokens = await pollDeviceCode(
          tenantId,
          clientId,
          deviceCode.device_code,
          deviceCode.interval,
          deviceCode.expires_in * 1000,
        );

        context.logger.info("Authentication successful");

        const handle = await context.writeResource("bootstrap", "main", {
          status: "authenticated",
          message:
            "Store the refreshToken in your vault. It expires after 90 days of inactivity.",
          refreshToken: tokens.refresh_token,
        });

        return { dataHandles: [handle] };
      },
    },

    list_teams: {
      description: "List Teams the signed-in user is a member of",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const accessToken = await getAccessToken(context.globalArgs);

        const result = await graphRequestPaginated<GraphTeam>(
          accessToken,
          "/me/joinedTeams",
          { "$select": "id,displayName,description" },
        );

        const handle = await context.writeResource("teams", "main", {
          teams: result.items,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} teams", {
          count: result.items.length,
        });
        return { dataHandles: [handle] };
      },
    },

    list_channels: {
      description: "List channels in a team",
      arguments: z.object({
        teamId: z.string().describe("Team ID (from list_teams output)"),
      }),
      execute: async (
        args: { teamId: string },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const accessToken = await getAccessToken(context.globalArgs);

        const team = await graphRequest<GraphTeam>(
          accessToken,
          "GET",
          `/teams/${args.teamId}`,
        );

        const channelsResult = await graphRequestPaginated<GraphChannel>(
          accessToken,
          `/teams/${args.teamId}/channels`,
          { "$select": "id,displayName,description,membershipType" },
        );

        const handle = await context.writeResource(
          "channels",
          args.teamId,
          {
            teamId: args.teamId,
            teamName: team.displayName,
            channels: channelsResult.items,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Found {count} channels in {team}",
          { count: channelsResult.items.length, team: team.displayName },
        );
        return { dataHandles: [handle] };
      },
    },

    channel_messages: {
      description:
        "Fetch threaded messages from a Teams channel. Returns root messages " +
        "with replies nested, ordered by most recently active thread first. " +
        "Each root costs one additional round-trip for replies.",
      arguments: z.object({
        teamId: z.string().describe("Team ID"),
        channelId: z.string().describe("Channel ID"),
        limit: z.number().int().min(1).max(100).default(30).describe(
          "Maximum root messages to fetch (replies under each are always fetched in full)",
        ),
        includeReplies: z.boolean().default(true).describe(
          "Fetch and nest replies under each root message",
        ),
      }),
      execute: async (
        args: {
          teamId: string;
          channelId: string;
          limit: number;
          includeReplies: boolean;
        },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const accessToken = await getAccessToken(context.globalArgs);

        const channel = await graphRequest<GraphChannel>(
          accessToken,
          "GET",
          `/teams/${args.teamId}/channels/${args.channelId}`,
        );

        // Fetch root messages (Graph returns newest-active first).
        // Cap pagination to prevent timeouts on quiet channels.
        const roots: GraphMessage[] = [];
        let nextUrl: string | undefined =
          `https://graph.microsoft.com/v1.0/teams/${args.teamId}/channels/${args.channelId}/messages?$top=50`;
        let pages = 0;

        while (
          nextUrl && roots.length < args.limit && pages < MAX_CHANNEL_PAGES
        ) {
          const page: GraphPagedResponse<GraphMessage> = await graphRequest(
            accessToken,
            "GET",
            nextUrl,
          );

          for (const m of page.value) {
            if (roots.length >= args.limit) break;
            roots.push(m);
          }

          nextUrl = page["@odata.nextLink"] ?? undefined;
          pages++;
        }

        // Filter to actual user messages (not system events).
        const userRoots = roots.filter(
          (m) => !m.messageType || m.messageType === "message",
        );

        // Fetch replies for each root (capped at 10 pages per thread).
        if (args.includeReplies) {
          for (const root of userRoots) {
            const repliesResult = await graphRequestPaginated<GraphMessage>(
              accessToken,
              `/teams/${args.teamId}/channels/${args.channelId}/messages/${root.id}/replies`,
              undefined,
              undefined,
              undefined,
              10,
            );
            (root as GraphMessage & { replies: GraphMessage[] }).replies =
              repliesResult.items.filter(
                (r: GraphMessage) =>
                  !r.messageType || r.messageType === "message",
              );
          }
        }

        const wasTruncated = roots.length >= args.limit ||
          pages >= MAX_CHANNEL_PAGES;

        const instanceId = `${args.teamId}__${args.channelId}`;
        const handle = await context.writeResource(
          "channelMessages",
          instanceId,
          {
            teamId: args.teamId,
            channelId: args.channelId,
            channelName: channel.displayName,
            messages: userRoots,
            totalRoots: userRoots.length,
            truncated: wasTruncated,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Fetched {count} threaded messages from {channel}",
          { count: userRoots.length, channel: channel.displayName },
        );
        return { dataHandles: [handle] };
      },
    },

    list_chats: {
      description:
        "List Teams chats (1:1 and group) the signed-in user participates in, " +
        "with member details and viewpoint read state",
      arguments: z.object({
        nameFilter: z.string().optional().describe(
          "Filter to chats where a member name/email contains this substring",
        ),
        limit: z.number().int().min(1).max(100).default(20).describe(
          "Maximum chats to return",
        ),
      }),
      execute: async (
        args: { nameFilter?: string; limit: number },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const accessToken = await getAccessToken(context.globalArgs);

        const pageSize = Math.min(args.limit * 5, 50).toString();
        const params: Record<string, string> = {
          "$top": pageSize,
          "$orderby": "lastMessagePreview/createdDateTime desc",
          "$expand": "members,viewpoint",
        };

        const MAX_CHAT_PAGES = 10;
        const allChats: GraphChat[] = [];
        const match = args.nameFilter?.toLowerCase();
        let chatPages = 0;

        let nextUrl: string | undefined =
          `https://graph.microsoft.com/v1.0/me/chats?${
            new URLSearchParams(params).toString()
          }`;

        while (
          nextUrl && allChats.length < args.limit && chatPages < MAX_CHAT_PAGES
        ) {
          const page: GraphPagedResponse<GraphChat> = await graphRequest(
            accessToken,
            "GET",
            nextUrl,
          );
          chatPages++;

          for (const ch of page.value) {
            if (match) {
              const members = ch.members ?? [];
              const hasMatch = members.some(
                (m: { displayName?: string | null; email?: string | null }) =>
                  (m.displayName?.toLowerCase().includes(match)) ||
                  (m.email?.toLowerCase().includes(match)),
              );
              if (!hasMatch) continue;
            }
            allChats.push(ch);
            if (allChats.length >= args.limit) break;
          }

          nextUrl = page["@odata.nextLink"] ?? undefined;
        }

        const truncated = allChats.length >= args.limit ||
          (nextUrl !== undefined && chatPages >= MAX_CHAT_PAGES);

        const handle = await context.writeResource("chats", "main", {
          chats: allChats,
          totalFetched: allChats.length,
          truncated,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Fetched {count} chats", {
          count: allChats.length,
        });
        return { dataHandles: [handle] };
      },
    },

    chat_messages: {
      description: "Fetch messages from a specific Teams chat, newest first",
      arguments: z.object({
        chatId: z.string().describe("Chat ID (from list_chats output)"),
        since: z.string().optional().describe(
          "Only messages at or after this ISO 8601 timestamp",
        ),
        limit: z.number().int().min(1).max(200).default(50).describe(
          "Maximum messages to return",
        ),
      }),
      execute: async (
        args: { chatId: string; since?: string; limit: number },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const accessToken = await getAccessToken(context.globalArgs);
        const sinceCutoff = args.since ? new Date(args.since) : null;

        const messages: GraphMessage[] = [];
        let nextUrl: string | undefined =
          `https://graph.microsoft.com/v1.0/chats/${args.chatId}/messages?$top=50`;

        while (nextUrl && messages.length < args.limit) {
          const page: GraphPagedResponse<GraphMessage> = await graphRequest(
            accessToken,
            "GET",
            nextUrl,
          );

          for (const m of page.value) {
            if (sinceCutoff && new Date(m.createdDateTime) < sinceCutoff) {
              nextUrl = undefined;
              break;
            }
            if (!m.messageType || m.messageType === "message") {
              messages.push(m);
            }
            if (messages.length >= args.limit) break;
          }

          if (nextUrl) {
            nextUrl = page["@odata.nextLink"] ?? undefined;
          }
        }

        const handle = await context.writeResource(
          "chatMessages",
          args.chatId,
          {
            chatId: args.chatId,
            messages,
            totalFetched: messages.length,
            truncated: messages.length >= args.limit,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Fetched {count} messages from chat", {
          count: messages.length,
        });
        return { dataHandles: [handle] };
      },
    },

    attention: {
      description:
        "Aggregate things that want your attention: unread chats and @mentions " +
        "within a time window. Mirrors lurk's attention command.",
      arguments: z.object({
        since: z.string().optional().describe(
          "Look back to this ISO 8601 timestamp (default: 24h ago)",
        ),
        chatLimit: z.number().int().min(1).max(100).default(50).describe(
          "Max chats to scan (most-recent-first)",
        ),
        mode: z.enum(["all", "mentions_only", "unread_only"]).default("all")
          .describe("Filter attention items by type"),
      }),
      execute: async (
        args: { since?: string; chatLimit: number; mode: string },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const accessToken = await getAccessToken(context.globalArgs);

        const cutoff = args.since
          ? new Date(args.since)
          : new Date(Date.now() - 24 * 60 * 60 * 1000);

        // Get caller identity for mention matching.
        let me: GraphUser = { id: "" };
        if (args.mode !== "unread_only") {
          me = await graphRequest<GraphUser>(
            accessToken,
            "GET",
            "/me?$select=id,displayName",
          );
        }

        // Fetch recent chats with viewpoint.
        const params: Record<string, string> = {
          "$top": "20",
          "$orderby": "lastMessagePreview/createdDateTime desc",
          "$expand": "members,viewpoint",
        };

        const chats: GraphChat[] = [];
        let nextUrl: string | undefined =
          `https://graph.microsoft.com/v1.0/me/chats?${
            new URLSearchParams(params).toString()
          }`;

        while (nextUrl && chats.length < args.chatLimit) {
          const page: GraphPagedResponse<GraphChat> = await graphRequest(
            accessToken,
            "GET",
            nextUrl,
          );

          const remaining = args.chatLimit - chats.length;
          chats.push(...page.value.slice(0, remaining));
          nextUrl = page["@odata.nextLink"] ?? undefined;
        }

        interface AttentionItem {
          reason: "mention" | "unread_chat";
          when: string;
          chatLabel: string;
          chat: GraphChat;
          message?: GraphMessage;
        }

        const items: AttentionItem[] = [];

        for (const ch of chats) {
          if (!ch.lastUpdatedDateTime) continue;
          if (new Date(ch.lastUpdatedDateTime) < cutoff) continue;

          // Check unread.
          if (args.mode !== "mentions_only") {
            const isUnread = !ch.viewpoint?.lastMessageReadDateTime ||
              new Date(ch.lastUpdatedDateTime) >
                new Date(ch.viewpoint.lastMessageReadDateTime);
            if (isUnread) {
              items.push({
                reason: "unread_chat",
                when: ch.lastUpdatedDateTime,
                chatLabel: chatLabel(ch),
                chat: ch,
              });
            }
          }

          // Scan for mentions.
          if (args.mode === "unread_only" || !me.id) continue;

          const MAX_MSG_PAGES_PER_CHAT = 5;
          let msgUrl: string | undefined =
            `https://graph.microsoft.com/v1.0/chats/${ch.id}/messages?$top=50`;
          const chatMsgs: GraphMessage[] = [];
          let msgPages = 0;

          while (msgUrl && msgPages < MAX_MSG_PAGES_PER_CHAT) {
            const page: GraphPagedResponse<GraphMessage> = await graphRequest(
              accessToken,
              "GET",
              msgUrl,
            );
            msgPages++;

            for (const m of page.value) {
              if (new Date(m.createdDateTime) < cutoff) {
                msgUrl = undefined;
                break;
              }
              chatMsgs.push(m);
            }

            if (msgUrl) {
              msgUrl = page["@odata.nextLink"] ?? undefined;
            }
          }

          for (const m of chatMsgs) {
            const mentionsMe = (m.mentions ?? []).some(
              (mention) => mention.mentioned?.user?.id === me.id,
            );
            if (mentionsMe) {
              items.push({
                reason: "mention",
                when: m.createdDateTime,
                chatLabel: chatLabel(ch),
                chat: ch,
                message: m,
              });
            }
          }
        }

        // Sort newest first.
        items.sort(
          (a, b) => new Date(b.when).getTime() - new Date(a.when).getTime(),
        );

        const handle = await context.writeResource("attention", "main", {
          items,
          totalItems: items.length,
          truncated: chats.length >= args.chatLimit,
          since: cutoff.toISOString(),
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info(
          "Found {count} attention items since {since}",
          { count: items.length, since: cutoff.toISOString() },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
