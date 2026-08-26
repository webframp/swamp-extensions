/**
 * Discourse forum model — query categories, topics, and posts via the
 * public REST API. No CLI dependencies.
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

const EXTENSION_NAME = "@webframp/discourse";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  host: z.string().min(1).describe(
    "Discourse instance hostname (e.g. discourse.example.com)",
  ),
  apiKey: z.string().optional().describe(
    "API key for authenticated access. Omit for public read-only.",
  ),
  apiUsername: z.string().optional().describe(
    "Discourse username matching the API key owner. Required when apiKey is set. Use 'system' only with global admin keys.",
  ),
});

const CategorySchema = z.object({
  id: z.number().describe("Category ID"),
  name: z.string().describe("Category display name"),
  slug: z.string().describe("Category URL slug"),
  topicCount: z.number().describe("Number of topics in this category"),
  description: z.string().nullable().describe("Category description text"),
});

const TopicSchema = z.object({
  id: z.number().describe("Topic ID"),
  title: z.string().describe("Topic title"),
  categoryId: z.number().describe("ID of the category this topic belongs to"),
  createdAt: z.string().describe(
    "ISO 8601 timestamp when the topic was created",
  ),
  postsCount: z.number().describe("Total number of posts in this topic"),
  views: z.number().describe("Total view count"),
  replyCount: z.number().describe(
    "Number of replies (excludes the original post)",
  ),
  lastPostedAt: z.string().nullable().describe(
    "ISO 8601 timestamp of the most recent post, if any",
  ),
  pinned: z.boolean().describe("True if the topic is pinned in its category"),
});

const TopicDetailSchema = z.object({
  id: z.number().describe("Topic ID"),
  title: z.string().describe("Topic title"),
  categoryId: z.number().describe("ID of the category this topic belongs to"),
  createdAt: z.string().describe(
    "ISO 8601 timestamp when the topic was created",
  ),
  postsCount: z.number().describe("Total number of posts in this topic"),
  views: z.number().describe("Total view count"),
  posts: z.array(z.object({
    id: z.number().describe("Post ID"),
    username: z.string().describe("Author's Discourse username"),
    createdAt: z.string().describe(
      "ISO 8601 timestamp when the post was created",
    ),
    cooked: z.string().describe("Rendered HTML content of the post"),
  })).describe("Posts fetched for this topic, in order"),
  truncated: z.boolean().describe(
    "True if fewer posts were fetched than postsCount reports",
  ),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when this topic was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const CategoriesResultSchema = z.object({
  categories: z.array(CategorySchema).describe("All forum categories"),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when this listing was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const TopicsResultSchema = z.object({
  topics: z.array(TopicSchema).describe("Topics returned for this page"),
  resultCount: z.number().describe("Number of topics in this result"),
  truncated: z.boolean().describe("True if more pages of topics are available"),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when this listing was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const SearchResultSchema = z.object({
  query: z.string().describe("The search query that produced these results"),
  topics: z.array(TopicSchema).describe("Matching topics for this page"),
  resultCount: z.number().describe("Number of topics in this result"),
  truncated: z.boolean().describe(
    "True if more search result pages are available",
  ),
  fetchedAt: z.string().describe("ISO 8601 timestamp when the search ran"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

// =============================================================================
// Helpers
// =============================================================================

interface ModelContext {
  globalArgs: { host: string; apiKey?: string; apiUsername?: string };
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{
    name: string;
    specName: string;
    kind: string;
    dataId: string;
    version: number;
    size: number;
  }>;
}

async function discourseFetch(
  host: string,
  path: string,
  apiKey?: string,
  apiUsername?: string,
): Promise<unknown> {
  const url = `https://${host}${path}`;
  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
  if (apiKey) {
    if (!apiUsername) {
      throw new Error(
        "apiUsername is required when apiKey is set. Set it to match the API key owner.",
      );
    }
    headers["Api-Key"] = apiKey;
    headers["Api-Username"] = apiUsername;
  }
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    let body: string;
    try {
      body = await resp.text();
    } catch {
      body = "[unable to read response body]";
    }
    throw new Error(
      `Discourse API ${resp.status} ${path}: ${body.slice(0, 200)}`,
    );
  }
  return resp.json();
}

function mapTopic(raw: Record<string, unknown>): z.infer<typeof TopicSchema> {
  return {
    id: raw.id as number,
    title: (raw.title as string) ?? "",
    categoryId: (raw.category_id as number) ?? 0,
    createdAt: (raw.created_at as string) ?? "",
    postsCount: (raw.posts_count as number) ?? 0,
    views: (raw.views as number) ?? 0,
    replyCount: (raw.reply_count as number) ?? 0,
    lastPostedAt: (raw.last_posted_at as string) ?? null,
    pinned: (raw.pinned as boolean) ?? false,
  };
}

// =============================================================================
// Model
// =============================================================================

/** Discourse forum model — query categories, topics, and posts via REST API. */
export const model = {
  type: "@webframp/discourse",
  version: "2026.08.25.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.18.1",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },

    {
      toVersion: "2026.08.24.1",

      description:
        "Added optional durationMs, collectedBy, and fetchedAt output metadata fields",

      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.25.1",
      description: "Label metadata update, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    categories: {
      description: "Forum category listing",
      schema: CategoriesResultSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    topics: {
      description: "Topic listing (latest or by category)",
      schema: TopicsResultSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    topicDetail: {
      description: "Full topic with posts",
      schema: TopicDetailSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    searchResults: {
      description: "Search results",
      schema: SearchResultSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    list_categories: {
      description: "List all forum categories with topic counts.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: ModelContext) => {
        const startMs = Date.now();
        const { host, apiKey, apiUsername } = context.globalArgs;
        const raw = await discourseFetch(
          host,
          "/categories.json",
          apiKey,
          apiUsername,
        ) as {
          category_list?: { categories?: Record<string, unknown>[] };
        };
        if (!Array.isArray(raw.category_list?.categories)) {
          throw new Error(
            `Discourse GET /categories.json on "${host}" returned an unexpected shape: ` +
              `expected a "category_list.categories" array, got ${
                JSON.stringify(raw).slice(0, 200)
              }`,
          );
        }
        const categories = raw.category_list.categories.map((c) => ({
          id: c.id as number,
          name: (c.name as string) ?? "",
          slug: (c.slug as string) ?? "",
          topicCount: (c.topic_count as number) ?? 0,
          description: (c.description_text as string) ?? null,
        }));
        const handle = await context.writeResource("categories", "all", {
          categories,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
        });
        context.logger.info("Fetched categories", { count: categories.length });
        return { dataHandles: [handle] };
      },
    },

    list_latest: {
      description: "List the latest topics across all categories.",
      arguments: z.object({
        page: z.number().int().min(0).default(0).describe(
          "Page number (0-based)",
        ),
      }),
      execute: async (
        args: { page: number },
        context: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, apiKey, apiUsername } = context.globalArgs;
        const raw = await discourseFetch(
          host,
          `/latest.json?page=${args.page}`,
          apiKey,
          apiUsername,
        ) as {
          topic_list?: {
            topics?: Record<string, unknown>[];
            more_topics_url?: string;
          };
        };
        if (!Array.isArray(raw.topic_list?.topics)) {
          throw new Error(
            `Discourse GET /latest.json?page=${args.page} on "${host}" returned an unexpected shape: ` +
              `expected a "topic_list.topics" array, got ${
                JSON.stringify(raw).slice(0, 200)
              }`,
          );
        }
        const topics = raw.topic_list.topics.map(mapTopic);
        const truncated = raw.topic_list.more_topics_url != null;
        const handle = await context.writeResource(
          "topics",
          `latest-page-${args.page}`,
          {
            topics,
            resultCount: topics.length,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        context.logger.info("Fetched latest topics", {
          count: topics.length,
          page: args.page,
        });
        return { dataHandles: [handle] };
      },
    },

    list_category_topics: {
      description: "List topics in a specific category by slug and ID.",
      arguments: z.object({
        slug: z.string().min(1).describe("Category slug (e.g. cyber-news)"),
        categoryId: z.number().int().positive().describe("Category ID"),
        page: z.number().int().min(0).default(0).describe(
          "Page number (0-based)",
        ),
      }),
      execute: async (
        args: { slug: string; categoryId: number; page: number },
        context: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, apiKey, apiUsername } = context.globalArgs;
        const raw = await discourseFetch(
          host,
          `/c/${
            encodeURIComponent(args.slug)
          }/${args.categoryId}.json?page=${args.page}`,
          apiKey,
          apiUsername,
        ) as {
          topic_list?: {
            topics?: Record<string, unknown>[];
            more_topics_url?: string;
          };
        };
        if (!Array.isArray(raw.topic_list?.topics)) {
          throw new Error(
            `Discourse GET /c/${args.slug}/${args.categoryId}.json?page=${args.page} on "${host}" returned an unexpected shape: ` +
              `expected a "topic_list.topics" array, got ${
                JSON.stringify(raw).slice(0, 200)
              }`,
          );
        }
        const topics = raw.topic_list.topics.map(mapTopic);
        const truncated = raw.topic_list.more_topics_url != null;
        const handle = await context.writeResource(
          "topics",
          `category-${args.slug}-${args.categoryId}-page-${args.page}`,
          {
            topics,
            resultCount: topics.length,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        context.logger.info("Fetched category topics", {
          slug: args.slug,
          count: topics.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_topic: {
      description: "Get a full topic with all posts.",
      arguments: z.object({
        topicId: z.number().int().positive().describe("Topic ID"),
      }),
      execute: async (
        args: { topicId: number },
        context: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, apiKey, apiUsername } = context.globalArgs;
        const raw = await discourseFetch(
          host,
          `/t/${args.topicId}.json`,
          apiKey,
          apiUsername,
        ) as Record<string, unknown>;
        const postStream = raw.post_stream as {
          posts: Record<string, unknown>[];
        };
        const posts = (postStream?.posts ?? []).map((p) => ({
          id: p.id as number,
          username: (p.username as string) ?? "",
          createdAt: (p.created_at as string) ?? "",
          cooked: (p.cooked as string) ?? "",
        }));
        const data = {
          id: raw.id as number,
          title: (raw.title as string) ?? "",
          categoryId: (raw.category_id as number) ?? 0,
          createdAt: (raw.created_at as string) ?? "",
          postsCount: (raw.posts_count as number) ?? 0,
          views: (raw.views as number) ?? 0,
          posts,
          truncated: posts.length < ((raw.posts_count as number) ?? 0),
          fetchedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "topicDetail",
          `topic-${args.topicId}`,
          {
            ...data,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        context.logger.info("Fetched topic", {
          topicId: args.topicId,
          posts: posts.length,
        });
        return { dataHandles: [handle] };
      },
    },

    search: {
      description: "Search topics and posts by keyword.",
      arguments: z.object({
        query: z.string().min(1).describe("Search query"),
        // Discourse search API is 1-based (unlike topic listing which is 0-based)
        page: z.number().int().min(1).default(1).describe(
          "Page number (1-based)",
        ),
      }),
      execute: async (
        args: { query: string; page: number },
        context: ModelContext,
      ) => {
        const startMs = Date.now();
        const { host, apiKey, apiUsername } = context.globalArgs;
        const raw = await discourseFetch(
          host,
          `/search.json?q=${encodeURIComponent(args.query)}&page=${args.page}`,
          apiKey,
          apiUsername,
        ) as {
          topics?: Record<string, unknown>[];
          grouped_search_result?: { more_full_page_results?: boolean };
        };
        const topics = (raw.topics ?? []).map(mapTopic);
        const truncated = raw.grouped_search_result?.more_full_page_results ??
          false;
        const queryKey = args.query.length > 50
          ? Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-1",
                new TextEncoder().encode(args.query),
              ),
            ),
          ).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12)
          : encodeURIComponent(args.query);
        const handle = await context.writeResource(
          "searchResults",
          `search-${queryKey}-page-${args.page}`,
          {
            query: args.query,
            topics,
            resultCount: topics.length,
            truncated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );
        context.logger.info("Search complete", {
          query: args.query,
          results: topics.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
