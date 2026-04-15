// Microsoft Outlook / Mail Model
// Manages Outlook mail via Microsoft Graph delegated access.
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { z } from "npm:zod@4";
import {
  initiateDeviceCode,
  MicrosoftAuthError,
  pollDeviceCode,
  refreshAccessToken,
} from "./_lib/auth.ts";
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

const MessageSchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  bodyPreview: z.string(),
  isRead: z.boolean(),
  isDraft: z.boolean(),
  importance: z.string(),
  hasAttachments: z.boolean(),
  receivedDateTime: z.string(),
  sentDateTime: z.string().nullable().optional(),
  from: z.object({
    emailAddress: z.object({ name: z.string(), address: z.string() }),
  }).optional(),
  toRecipients: z.array(
    z.object({
      emailAddress: z.object({ name: z.string(), address: z.string() }),
    }),
  ).optional(),
  categories: z.array(z.string()).optional(),
  flag: z.object({ flagStatus: z.string() }).optional(),
  webLink: z.string().optional(),
});

const FolderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  totalItemCount: z.number(),
  unreadItemCount: z.number(),
  childFolderCount: z.number(),
  isHidden: z.boolean().optional(),
});

const InboxListSchema = z.object({
  messages: z.array(MessageSchema),
  totalFetched: z.number(),
  fetchedAt: z.string(),
  filter: z.string().optional(),
});

const FolderListSchema = z.object({
  folders: z.array(FolderSchema),
  fetchedAt: z.string(),
});

const SearchResultSchema = z.object({
  query: z.string(),
  messages: z.array(MessageSchema),
  totalFetched: z.number(),
  fetchedAt: z.string(),
});

const ThreadSchema = z.object({
  threadId: z.string(),
  subject: z.string().nullable(),
  messages: z.array(MessageSchema),
  messageCount: z.number(),
  fetchedAt: z.string(),
});

const BootstrapSchema = z.object({
  displayName: z.string(),
  mail: z.string().nullable(),
  bootstrappedAt: z.string(),
  note: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

/** Obtain a fresh access token using the stored refresh token. */
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

const PREFER_TEXT_BODY: Record<string, string> = {
  "Prefer": 'outlook.body-content-type="text"',
};

// =============================================================================
// Model Definition
// =============================================================================

export const model = {
  type: "@webframp/microsoft/outlook",
  version: "2026.04.15.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    inbox: {
      description: "Messages fetched from the inbox (or a filter thereof)",
      schema: InboxListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    folders: {
      description: "Mail folders in the mailbox",
      schema: FolderListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    search: {
      description: "Search results for a mail query",
      schema: SearchResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    thread: {
      description: "Full message thread",
      schema: ThreadSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    bootstrap: {
      description: "Bootstrap result confirming successful authentication",
      schema: BootstrapSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    /**
     * One-time device code flow bootstrap.
     * Prints the user code and verification URL, waits for the user to
     * authenticate, and writes the resulting refresh token back as model
     * output. Copy the refreshToken from the output into your vault / global
     * args for all subsequent calls.
     */
    bootstrap: {
      description:
        "Authenticate via device code flow and capture a refresh token. " +
        "Run once; re-run if you receive an invalid_grant error.",
      arguments: z.object({
        timeoutSeconds: z.number().int().min(60).max(900).default(300).describe(
          "How long to wait for the user to complete device code auth (seconds)",
        ),
      }),
      execute: async (
        args: { timeoutSeconds: number },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
            warn: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { tenantId, clientId, clientSecret } = context.globalArgs;

        const deviceCodeResp = await initiateDeviceCode(tenantId, clientId);

        // Surface the user instructions — the logger output is visible in the
        // swamp UI and CLI during method execution.
        context.logger.info(
          "ACTION REQUIRED: {message}",
          { message: deviceCodeResp.message },
        );
        context.logger.info(
          "Waiting up to {timeout}s for authentication...",
          { timeout: args.timeoutSeconds },
        );

        const tokens = await pollDeviceCode(
          tenantId,
          clientId,
          clientSecret,
          deviceCodeResp.device_code,
          deviceCodeResp.interval,
          args.timeoutSeconds * 1000,
        );

        // Fetch the signed-in user's profile to confirm identity.
        const me = await graphRequest<{ displayName: string; mail?: string }>(
          tokens.access_token,
          "GET",
          "/me",
        );

        context.logger.info(
          "Authenticated as {name} ({mail}). " +
            "Copy the refreshToken from the output resource into your vault.",
          { name: me.displayName, mail: me.mail ?? "(no mail)" },
        );

        const handle = await context.writeResource("bootstrap", "main", {
          displayName: me.displayName,
          mail: me.mail ?? null,
          bootstrappedAt: new Date().toISOString(),
          note: "Copy the refreshToken from globalArgs.refreshToken " +
            "(it has been updated in-memory for this execution). " +
            "Store it in your vault under the refreshToken key.",
        });

        // Expose the new refresh token via the global arg mutation path.
        // In practice swamp surfaces this so the user can copy it to their vault.
        (context.globalArgs as Record<string, unknown>)["refreshToken"] =
          tokens.refresh_token;

        return { dataHandles: [handle] };
      },
    },

    list_inbox: {
      description: "Fetch messages from the inbox, newest first",
      arguments: z.object({
        top: z.number().int().min(1).max(200).default(50).describe(
          "Maximum messages to fetch",
        ),
        unreadOnly: z.boolean().default(false).describe(
          "Only return unread messages",
        ),
        folder: z.string().default("Inbox").describe(
          "Folder display name or well-known name (Inbox, SentItems, Drafts, …)",
        ),
      }),
      execute: async (
        args: { top: number; unreadOnly: boolean; folder: string },
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
          "$orderby": "receivedDateTime desc",
          "$select":
            "id,subject,bodyPreview,isRead,isDraft,importance,hasAttachments," +
            "receivedDateTime,sentDateTime,from,toRecipients,categories,flag,webLink",
        };

        if (args.unreadOnly) {
          params["$filter"] = "isRead eq false";
        }

        const folderPath = args.folder === "Inbox" || args.folder === "inbox"
          ? "/me/mailFolders/Inbox/messages"
          : `/me/mailFolders/${encodeURIComponent(args.folder)}/messages`;

        const messages = await graphRequestPaginated<
          z.infer<typeof MessageSchema>
        >(
          accessToken,
          folderPath,
          params,
          PREFER_TEXT_BODY,
        );

        const filter = args.unreadOnly ? "unread" : undefined;
        const handle = await context.writeResource("inbox", "main", {
          messages,
          totalFetched: messages.length,
          fetchedAt: new Date().toISOString(),
          filter,
        });

        context.logger.info(
          "Fetched {count} messages from {folder}",
          { count: messages.length, folder: args.folder },
        );

        return { dataHandles: [handle] };
      },
    },

    list_folders: {
      description: "List all mail folders in the mailbox",
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

        const folders = await graphRequestPaginated<
          z.infer<typeof FolderSchema>
        >(
          accessToken,
          "/me/mailFolders",
          {
            "$select":
              "id,displayName,totalItemCount,unreadItemCount,childFolderCount,isHidden",
          },
        );

        const handle = await context.writeResource("folders", "main", {
          folders,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} mail folders", {
          count: folders.length,
        });

        return { dataHandles: [handle] };
      },
    },

    search_mail: {
      description: "Search mail using OData $search or $filter",
      arguments: z.object({
        query: z.string().describe(
          "KQL search query (e.g. 'from:boss@example.com' or 'subject:invoice')",
        ),
        top: z.number().int().min(1).max(100).default(25).describe(
          "Maximum results to return",
        ),
      }),
      execute: async (
        args: { query: string; top: number },
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
          z.infer<typeof MessageSchema>
        >(
          accessToken,
          "/me/messages",
          {
            "$search": `"${args.query}"`,
            "$top": String(args.top),
            "$select":
              "id,subject,bodyPreview,isRead,importance,hasAttachments," +
              "receivedDateTime,from,categories,flag,webLink",
          },
          PREFER_TEXT_BODY,
        );

        const handle = await context.writeResource("search", args.query, {
          query: args.query,
          messages,
          totalFetched: messages.length,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info(
          "Search '{query}' returned {count} messages",
          { query: args.query, count: messages.length },
        );

        return { dataHandles: [handle] };
      },
    },

    categorize: {
      description: "Add a category label to a message",
      arguments: z.object({
        messageId: z.string().describe("Graph message ID"),
        categories: z.array(z.string()).min(1).describe(
          "Category names to apply (must already exist in the mailbox)",
        ),
      }),
      execute: async (
        args: { messageId: string; categories: string[] },
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

        const updated = await graphRequest<z.infer<typeof MessageSchema>>(
          accessToken,
          "PATCH",
          `/me/messages/${args.messageId}`,
          { categories: args.categories },
        );

        const handle = await context.writeResource(
          "inbox",
          args.messageId,
          {
            messages: [updated],
            totalFetched: 1,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Applied categories {cats} to message {id}",
          {
            cats: args.categories.join(", "),
            id: args.messageId,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    flag: {
      description: "Set or clear the follow-up flag on a message",
      arguments: z.object({
        messageId: z.string().describe("Graph message ID"),
        flagStatus: z.enum(["flagged", "complete", "notFlagged"]).describe(
          "New flag status",
        ),
      }),
      execute: async (
        args: { messageId: string; flagStatus: string },
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

        const updated = await graphRequest<z.infer<typeof MessageSchema>>(
          accessToken,
          "PATCH",
          `/me/messages/${args.messageId}`,
          { flag: { flagStatus: args.flagStatus } },
        );

        const handle = await context.writeResource(
          "inbox",
          args.messageId,
          {
            messages: [updated],
            totalFetched: 1,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Set flag to {status} on message {id}",
          { status: args.flagStatus, id: args.messageId },
        );

        return { dataHandles: [handle] };
      },
    },

    mark_read: {
      description: "Mark one or more messages as read or unread",
      arguments: z.object({
        messageIds: z.array(z.string()).min(1).describe(
          "Graph message IDs to update",
        ),
        isRead: z.boolean().default(true).describe(
          "true = mark read, false = mark unread",
        ),
      }),
      execute: async (
        args: { messageIds: string[]; isRead: boolean },
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
        const handles = [];

        for (const id of args.messageIds) {
          const updated = await graphRequest<z.infer<typeof MessageSchema>>(
            accessToken,
            "PATCH",
            `/me/messages/${id}`,
            { isRead: args.isRead },
          );
          const handle = await context.writeResource("inbox", id, {
            messages: [updated],
            totalFetched: 1,
            fetchedAt: new Date().toISOString(),
          });
          handles.push(handle);
        }

        context.logger.info(
          "Marked {count} message(s) as {state}",
          {
            count: args.messageIds.length,
            state: args.isRead ? "read" : "unread",
          },
        );

        return { dataHandles: handles };
      },
    },

    summarize_thread: {
      description: "Fetch all messages in a conversation thread, newest first",
      arguments: z.object({
        conversationId: z.string().describe(
          "Outlook conversationId (available on any message)",
        ),
        top: z.number().int().min(1).max(100).default(50).describe(
          "Maximum messages to fetch from the thread",
        ),
      }),
      execute: async (
        args: { conversationId: string; top: number },
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
          z.infer<typeof MessageSchema>
        >(
          accessToken,
          "/me/messages",
          {
            "$filter": `conversationId eq '${args.conversationId}'`,
            "$orderby": "receivedDateTime desc",
            "$top": String(args.top),
            "$select":
              "id,subject,bodyPreview,isRead,importance,hasAttachments," +
              "receivedDateTime,from,toRecipients,categories,flag,webLink",
          },
          PREFER_TEXT_BODY,
        );

        const subject = messages[0]?.subject ?? null;
        const handle = await context.writeResource(
          "thread",
          args.conversationId,
          {
            threadId: args.conversationId,
            subject,
            messages,
            messageCount: messages.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Fetched {count} messages in thread '{subject}'",
          { count: messages.length, subject: subject ?? "(no subject)" },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};

// Re-export auth error for callers that want to catch it.
export { MicrosoftAuthError };
