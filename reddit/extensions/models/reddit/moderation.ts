/**
 * Reddit Moderation model for swamp.
 *
 * Provides read-only methods to inspect moderation queues, reports,
 * moderation logs, comments, posts, and user information for a subreddit.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4";
import { createRedditClient } from "./_lib/api.ts";

// =============================================================================
// Global Arguments
// =============================================================================

const GlobalArgsSchema = z.object({
  subreddit: z.string().describe("Subreddit name (without r/ prefix)"),
  clientId: z.string().describe("Reddit OAuth2 application client ID"),
  clientSecret: z.string().meta({ sensitive: true }).describe(
    "Reddit OAuth2 application client secret",
  ),
  username: z.string().describe("Reddit account username"),
  password: z.string().meta({ sensitive: true }).describe(
    "Reddit account password",
  ),
  userAgent: z.string().describe(
    "User-Agent string for Reddit API requests (e.g. 'swamp:modbot:v1.0 by /u/yourname')",
  ),
});

// =============================================================================
// Resource Schemas
// =============================================================================

const ModqueueItemSchema = z.object({
  id: z.string(),
  name: z.string().describe("Reddit fullname (t1_ for comment, t3_ for link)"),
  kind: z.enum(["comment", "link"]),
  title: z.string().optional(),
  body: z.string().optional(),
  author: z.string(),
  subreddit: z.string(),
  created_utc: z.number(),
  permalink: z.string(),
  num_reports: z.number(),
  mod_reports: z.array(z.array(z.string())),
  user_reports: z.array(z.array(z.union([z.string(), z.number()]))),
  approved_by: z.string().nullable().optional(),
  banned_by: z.string().nullable().optional(),
  removed: z.boolean().optional(),
}).passthrough();

const ModqueueListSchema = z.object({
  items: z.array(ModqueueItemSchema),
  truncated: z.boolean(),
});

const ModlogEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  mod: z.string(),
  target_fullname: z.string().nullable().optional(),
  target_author: z.string().nullable().optional(),
  target_permalink: z.string().nullable().optional(),
  details: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  created_utc: z.number(),
}).passthrough();

const ModlogListSchema = z.object({
  items: z.array(ModlogEntrySchema),
  truncated: z.boolean(),
});

const CommentSchema = z.object({
  id: z.string(),
  name: z.string(),
  body: z.string(),
  author: z.string(),
  subreddit: z.string(),
  created_utc: z.number(),
  permalink: z.string(),
  score: z.number(),
  parent_id: z.string(),
  link_id: z.string(),
  is_submitter: z.boolean(),
  edited: z.union([z.number(), z.literal(false)]),
}).passthrough();

const CommentListSchema = z.object({
  items: z.array(CommentSchema),
  truncated: z.boolean(),
});

const PostSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  selftext: z.string(),
  author: z.string(),
  subreddit: z.string(),
  created_utc: z.number(),
  permalink: z.string(),
  score: z.number(),
  num_comments: z.number(),
  url: z.string(),
  is_self: z.boolean(),
  over_18: z.boolean(),
  spoiler: z.boolean(),
  locked: z.boolean(),
  stickied: z.boolean(),
}).passthrough();

const PostListSchema = z.object({
  items: z.array(PostSchema),
  truncated: z.boolean(),
});

const UserInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_utc: z.number(),
  link_karma: z.number(),
  comment_karma: z.number(),
  is_suspended: z.boolean().optional(),
  is_mod: z.boolean().optional(),
  has_verified_email: z.boolean(),
  icon_img: z.string(),
}).passthrough();

// =============================================================================
// Type aliases for context
// =============================================================================

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
}

// =============================================================================
// Model Definition
// =============================================================================

/** Reddit moderation model providing read-only access to subreddit moderation data. */
export const model = {
  type: "@webframp/reddit/moderation",
  version: "2026.05.23.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    modqueue: {
      description: "Items pending moderator review (posts and comments)",
      schema: ModqueueListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    reports: {
      description: "User-reported content awaiting moderator action",
      schema: ModqueueListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    modlog: {
      description: "Moderator action log entries",
      schema: ModlogListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    comments: {
      description: "Subreddit comments",
      schema: CommentListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    posts: {
      description: "Subreddit posts",
      schema: PostListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    user_info: {
      description: "Information about a specific Reddit user",
      schema: UserInfoSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    get_modqueue: {
      description:
        "Retrieve items in the moderation queue pending review (posts, comments, or all)",
      arguments: z.object({
        type: z.enum(["posts", "comments", "all"]).default("all").describe(
          "Filter modqueue by item type",
        ),
        limit: z.number().int().min(1).max(100).default(25).describe(
          "Maximum number of items to return",
        ),
      }),
      execute: async (
        args: { type?: string; limit?: number },
        context: MethodContext,
      ) => {
        const { subreddit, ...creds } = context.globalArgs;
        const client = createRedditClient(creds);
        const type = args.type ?? "all";
        const limit = args.limit ?? 25;

        const params: Record<string, string> = {};
        if (type === "posts") params.only = "links";
        else if (type === "comments") params.only = "comments";

        const { items, truncated } = await client.paginate<
          Record<string, unknown>
        >(
          `/r/${subreddit}/about/modqueue`,
          limit,
          params,
        );

        const instanceName = `modqueue-${type}`;
        const handle = await context.writeResource("modqueue", instanceName, {
          items,
          truncated,
        });

        context.logger.info("Fetched {count} modqueue items", {
          count: items.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_reports: {
      description: "Retrieve user-reported content awaiting moderator action",
      arguments: z.object({
        limit: z.number().int().min(1).max(100).default(25).describe(
          "Maximum number of reported items to return",
        ),
      }),
      execute: async (
        args: { limit?: number },
        context: MethodContext,
      ) => {
        const { subreddit, ...creds } = context.globalArgs;
        const client = createRedditClient(creds);
        const limit = args.limit ?? 25;

        const { items, truncated } = await client.paginate<
          Record<string, unknown>
        >(
          `/r/${subreddit}/about/reports`,
          limit,
        );

        const handle = await context.writeResource(
          "reports",
          "reports-latest",
          {
            items,
            truncated,
          },
        );

        context.logger.info("Fetched {count} reported items", {
          count: items.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_modlog: {
      description:
        "Retrieve the moderator action log, optionally filtered by action type or moderator",
      arguments: z.object({
        action: z.string().optional().describe(
          "Filter by action type (e.g. removecomment, approvelink, banuser)",
        ),
        mod: z.string().optional().describe(
          "Filter by moderator username",
        ),
        limit: z.number().int().min(1).max(100).default(25).describe(
          "Maximum number of log entries to return",
        ),
      }),
      execute: async (
        args: { action?: string; mod?: string; limit?: number },
        context: MethodContext,
      ) => {
        const { subreddit, ...creds } = context.globalArgs;
        const client = createRedditClient(creds);
        const limit = args.limit ?? 25;

        const params: Record<string, string> = {};
        if (args.action) params.type = args.action;
        if (args.mod) params.mod = args.mod;

        const { items, truncated } = await client.paginate<
          Record<string, unknown>
        >(
          `/r/${subreddit}/about/log`,
          limit,
          params,
        );

        const instanceName = `modlog-${args.action || "all"}`;
        const handle = await context.writeResource("modlog", instanceName, {
          items,
          truncated,
        });

        context.logger.info("Fetched {count} modlog entries", {
          count: items.length,
        });
        return { dataHandles: [handle] };
      },
    },

    list_comments: {
      description: "List recent comments in the subreddit",
      arguments: z.object({
        sort: z.enum(["new", "hot", "top", "controversial"]).default("new")
          .describe("Sort order for comments"),
        limit: z.number().int().min(1).max(100).default(25).describe(
          "Maximum number of comments to return",
        ),
      }),
      execute: async (
        args: { sort?: string; limit?: number },
        context: MethodContext,
      ) => {
        const { subreddit, ...creds } = context.globalArgs;
        const client = createRedditClient(creds);
        const sort = args.sort ?? "new";
        const limit = args.limit ?? 25;

        const params: Record<string, string> = { sort };

        const { items, truncated } = await client.paginate<
          Record<string, unknown>
        >(
          `/r/${subreddit}/comments`,
          limit,
          params,
        );

        const instanceName = `comments-${sort}`;
        const handle = await context.writeResource("comments", instanceName, {
          items,
          truncated,
        });

        context.logger.info("Fetched {count} comments", {
          count: items.length,
        });
        return { dataHandles: [handle] };
      },
    },

    list_posts: {
      description: "List posts in the subreddit by sort order",
      arguments: z.object({
        sort: z.enum(["new", "hot", "top", "rising", "controversial"]).default(
          "new",
        ).describe("Sort order for posts"),
        limit: z.number().int().min(1).max(100).default(25).describe(
          "Maximum number of posts to return",
        ),
      }),
      execute: async (
        args: { sort?: string; limit?: number },
        context: MethodContext,
      ) => {
        const { subreddit, ...creds } = context.globalArgs;
        const client = createRedditClient(creds);
        const sort = args.sort ?? "new";
        const limit = args.limit ?? 25;

        const { items, truncated } = await client.paginate<
          Record<string, unknown>
        >(
          `/r/${subreddit}/${sort}`,
          limit,
        );

        const instanceName = `posts-${sort}`;
        const handle = await context.writeResource("posts", instanceName, {
          items,
          truncated,
        });

        context.logger.info("Fetched {count} posts", { count: items.length });
        return { dataHandles: [handle] };
      },
    },

    get_user_info: {
      description: "Retrieve information about a specific Reddit user",
      arguments: z.object({
        username: z.string().describe("Reddit username to look up"),
      }),
      execute: async (
        args: { username: string },
        context: MethodContext,
      ) => {
        const creds = {
          clientId: context.globalArgs.clientId,
          clientSecret: context.globalArgs.clientSecret,
          username: context.globalArgs.username,
          password: context.globalArgs.password,
          userAgent: context.globalArgs.userAgent,
        };
        const client = createRedditClient(creds);

        const response = await client.api<{ data: Record<string, unknown> }>(
          `/user/${args.username}/about`,
        );

        const userData = response.data;
        const instanceName = `user-${args.username}`;
        const handle = await context.writeResource(
          "user_info",
          instanceName,
          userData,
        );

        context.logger.info("Fetched user info for {username}", {
          username: args.username,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
