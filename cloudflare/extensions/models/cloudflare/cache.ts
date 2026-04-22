/**
 * Cloudflare Cache and CDN Management model for swamp.
 *
 * Provides methods to purge cached content (all, by URL, by tag, or by
 * prefix), inspect and update cache-related zone settings, and retrieve
 * cache analytics including hit rates and bandwidth via the Cloudflare
 * GraphQL Analytics API.
 *
 * @module
 */
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { z } from "npm:zod@4";
import { cfApi } from "./_lib/api.ts";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  apiToken: z.string().meta({ sensitive: true }).describe(
    "Cloudflare API token with Cache Purge permissions",
  ),
  zoneId: z.string().describe("Zone ID to manage cache for"),
});

const PurgeResultSchema = z.object({
  zoneId: z.string(),
  purgeType: z.string(),
  purgedAt: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const CacheSettingsSchema = z.object({
  zoneId: z.string(),
  cacheLevel: z.string().optional(),
  browserCacheTtl: z.number().optional(),
  alwaysOnline: z.string().optional(),
  developmentMode: z.number().optional(),
  minify: z.object({
    css: z.boolean(),
    html: z.boolean(),
    js: z.boolean(),
  }).optional(),
  polish: z.string().optional(),
  webp: z.string().optional(),
  fetchedAt: z.string(),
});

const AnalyticsSchema = z.object({
  zoneId: z.string(),
  timeRange: z.string(),
  requests: z.object({
    all: z.number(),
    cached: z.number(),
    uncached: z.number(),
    cacheHitRate: z.number(),
  }),
  bandwidth: z.object({
    all: z.number(),
    cached: z.number(),
    uncached: z.number(),
  }),
  fetchedAt: z.string(),
});

// =============================================================================
// Model Definition
// =============================================================================

/** Cloudflare Cache model definition with methods for cache purge, settings management, and analytics. */
export const model = {
  type: "@webframp/cloudflare/cache",
  version: "2026.03.28.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    "purge": {
      description: "Cache purge operation result",
      schema: PurgeResultSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    "settings": {
      description: "Cache-related zone settings",
      schema: CacheSettingsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "analytics": {
      description: "Cache analytics and hit rates",
      schema: AnalyticsSchema,
      lifetime: "1d" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    purge_all: {
      description: "Purge all cached content for the zone",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: { apiToken: string; zoneId: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, zoneId } = context.globalArgs;

        await cfApi(
          apiToken,
          "POST",
          `/zones/${zoneId}/purge_cache`,
          { purge_everything: true },
        );

        const handle = await context.writeResource("purge", "latest", {
          zoneId,
          purgeType: "everything",
          purgedAt: new Date().toISOString(),
        });

        context.logger.info("Purged all cached content for zone {zoneId}", {
          zoneId,
        });
        return { dataHandles: [handle] };
      },
    },

    purge_urls: {
      description: "Purge specific URLs from cache",
      arguments: z.object({
        urls: z.array(z.string()).describe("List of URLs to purge (max 30)"),
      }),
      execute: async (
        args: { urls: string[] },
        context: {
          globalArgs: { apiToken: string; zoneId: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, zoneId } = context.globalArgs;

        if (args.urls.length > 30) {
          throw new Error("Maximum 30 URLs can be purged at once");
        }

        await cfApi(
          apiToken,
          "POST",
          `/zones/${zoneId}/purge_cache`,
          { files: args.urls },
        );

        const handle = await context.writeResource("purge", "latest", {
          zoneId,
          purgeType: "urls",
          purgedAt: new Date().toISOString(),
          details: { urls: args.urls },
        });

        context.logger.info("Purged {count} URLs from cache", {
          count: args.urls.length,
        });
        return { dataHandles: [handle] };
      },
    },

    purge_tags: {
      description: "Purge cache by Cache-Tag headers (Enterprise only)",
      arguments: z.object({
        tags: z.array(z.string()).describe("List of Cache-Tag values to purge"),
      }),
      execute: async (
        args: { tags: string[] },
        context: {
          globalArgs: { apiToken: string; zoneId: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, zoneId } = context.globalArgs;

        await cfApi(
          apiToken,
          "POST",
          `/zones/${zoneId}/purge_cache`,
          { tags: args.tags },
        );

        const handle = await context.writeResource("purge", "latest", {
          zoneId,
          purgeType: "tags",
          purgedAt: new Date().toISOString(),
          details: { tags: args.tags },
        });

        context.logger.info("Purged cache for {count} tags", {
          count: args.tags.length,
        });
        return { dataHandles: [handle] };
      },
    },

    purge_prefixes: {
      description: "Purge cache by URL prefixes (Enterprise only)",
      arguments: z.object({
        prefixes: z.array(z.string()).describe("List of URL prefixes to purge"),
      }),
      execute: async (
        args: { prefixes: string[] },
        context: {
          globalArgs: { apiToken: string; zoneId: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, zoneId } = context.globalArgs;

        await cfApi(
          apiToken,
          "POST",
          `/zones/${zoneId}/purge_cache`,
          { prefixes: args.prefixes },
        );

        const handle = await context.writeResource("purge", "latest", {
          zoneId,
          purgeType: "prefixes",
          purgedAt: new Date().toISOString(),
          details: { prefixes: args.prefixes },
        });

        context.logger.info("Purged cache for {count} prefixes", {
          count: args.prefixes.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_settings: {
      description: "Get cache-related settings for the zone",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: { apiToken: string; zoneId: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, zoneId } = context.globalArgs;

        // Fetch relevant settings
        const settingsArray = await cfApi<
          Array<{ id: string; value: unknown }>
        >(
          apiToken,
          "GET",
          `/zones/${zoneId}/settings`,
        );

        const settingsMap = new Map(settingsArray.map((s) => [s.id, s.value]));

        const settings = {
          zoneId,
          cacheLevel: settingsMap.get("cache_level") as string | undefined,
          browserCacheTtl: settingsMap.get("browser_cache_ttl") as
            | number
            | undefined,
          alwaysOnline: settingsMap.get("always_online") as string | undefined,
          developmentMode: settingsMap.get("development_mode") as
            | number
            | undefined,
          minify: settingsMap.get("minify") as {
            css: boolean;
            html: boolean;
            js: boolean;
          } | undefined,
          polish: settingsMap.get("polish") as string | undefined,
          webp: settingsMap.get("webp") as string | undefined,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "settings",
          "main",
          settings,
        );

        context.logger.info("Fetched cache settings for zone {zoneId}", {
          zoneId,
        });
        return { dataHandles: [handle] };
      },
    },

    set_cache_level: {
      description: "Set the cache level for the zone",
      arguments: z.object({
        level: z.enum(["bypass", "basic", "simplified", "aggressive"])
          .describe(
            "Cache level: bypass (no cache), basic, simplified, or aggressive",
          ),
      }),
      execute: async (
        args: { level: string },
        context: {
          globalArgs: { apiToken: string; zoneId: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, zoneId } = context.globalArgs;

        await cfApi(
          apiToken,
          "PATCH",
          `/zones/${zoneId}/settings/cache_level`,
          { value: args.level },
        );

        // Fetch updated settings
        const settingsArray = await cfApi<
          Array<{ id: string; value: unknown }>
        >(
          apiToken,
          "GET",
          `/zones/${zoneId}/settings`,
        );

        const settingsMap = new Map(settingsArray.map((s) => [s.id, s.value]));

        const settings = {
          zoneId,
          cacheLevel: settingsMap.get("cache_level") as string | undefined,
          browserCacheTtl: settingsMap.get("browser_cache_ttl") as
            | number
            | undefined,
          alwaysOnline: settingsMap.get("always_online") as string | undefined,
          developmentMode: settingsMap.get("development_mode") as
            | number
            | undefined,
          minify: settingsMap.get("minify") as {
            css: boolean;
            html: boolean;
            js: boolean;
          } | undefined,
          polish: settingsMap.get("polish") as string | undefined,
          webp: settingsMap.get("webp") as string | undefined,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "settings",
          "main",
          settings,
        );

        context.logger.info("Set cache level to {level}", {
          level: args.level,
        });
        return { dataHandles: [handle] };
      },
    },

    toggle_dev_mode: {
      description: "Toggle development mode (bypasses cache for 3 hours)",
      arguments: z.object({
        enabled: z.boolean().describe("Enable or disable development mode"),
      }),
      execute: async (
        args: { enabled: boolean },
        context: {
          globalArgs: { apiToken: string; zoneId: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, zoneId } = context.globalArgs;

        await cfApi(
          apiToken,
          "PATCH",
          `/zones/${zoneId}/settings/development_mode`,
          { value: args.enabled ? "on" : "off" },
        );

        // Fetch updated settings
        const settingsArray = await cfApi<
          Array<{ id: string; value: unknown }>
        >(
          apiToken,
          "GET",
          `/zones/${zoneId}/settings`,
        );

        const settingsMap = new Map(settingsArray.map((s) => [s.id, s.value]));

        const settings = {
          zoneId,
          cacheLevel: settingsMap.get("cache_level") as string | undefined,
          browserCacheTtl: settingsMap.get("browser_cache_ttl") as
            | number
            | undefined,
          alwaysOnline: settingsMap.get("always_online") as string | undefined,
          developmentMode: settingsMap.get("development_mode") as
            | number
            | undefined,
          minify: settingsMap.get("minify") as {
            css: boolean;
            html: boolean;
            js: boolean;
          } | undefined,
          polish: settingsMap.get("polish") as string | undefined,
          webp: settingsMap.get("webp") as string | undefined,
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "settings",
          "main",
          settings,
        );

        const status = args.enabled ? "enabled" : "disabled";
        context.logger.info("Development mode {status}", { status });
        return { dataHandles: [handle] };
      },
    },

    get_analytics: {
      description: "Get cache analytics (hit rate, bandwidth)",
      arguments: z.object({
        since: z.string().default("-1440").describe(
          "Start time (minutes ago, e.g., '-1440' for last 24h)",
        ),
        until: z.string().default("0").describe(
          "End time (minutes ago, '0' for now)",
        ),
      }),
      execute: async (
        args: { since: string; until: string },
        context: {
          globalArgs: { apiToken: string; zoneId: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, zoneId } = context.globalArgs;

        // Use GraphQL for analytics
        const query = `
          query {
            viewer {
              zones(filter: { zoneTag: "${zoneId}" }) {
                httpRequests1dGroups(
                  limit: 1
                  filter: { date_geq: "${
          getDateMinutesAgo(parseInt(args.since))
        }", date_leq: "${getDateMinutesAgo(parseInt(args.until))}" }
                ) {
                  sum {
                    requests
                    cachedRequests
                    bytes
                    cachedBytes
                  }
                }
              }
            }
          }
        `;

        const response = await fetch(
          "https://api.cloudflare.com/client/v4/graphql",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query }),
          },
        );

        const data = await response.json() as {
          data?: {
            viewer?: {
              zones?: Array<{
                httpRequests1dGroups?: Array<{
                  sum?: {
                    requests?: number;
                    cachedRequests?: number;
                    bytes?: number;
                    cachedBytes?: number;
                  };
                }>;
              }>;
            };
          };
        };

        const stats = data.data?.viewer?.zones?.[0]?.httpRequests1dGroups?.[0]
          ?.sum;

        const allRequests = stats?.requests ?? 0;
        const cachedRequests = stats?.cachedRequests ?? 0;
        const uncachedRequests = allRequests - cachedRequests;
        const cacheHitRate = allRequests > 0
          ? (cachedRequests / allRequests) * 100
          : 0;

        const allBytes = stats?.bytes ?? 0;
        const cachedBytes = stats?.cachedBytes ?? 0;
        const uncachedBytes = allBytes - cachedBytes;

        const analytics = {
          zoneId,
          timeRange: `${args.since} to ${args.until} minutes`,
          requests: {
            all: allRequests,
            cached: cachedRequests,
            uncached: uncachedRequests,
            cacheHitRate: Math.round(cacheHitRate * 100) / 100,
          },
          bandwidth: {
            all: allBytes,
            cached: cachedBytes,
            uncached: uncachedBytes,
          },
          fetchedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "analytics",
          "main",
          analytics,
        );

        context.logger.info(
          "Cache hit rate: {rate}% ({cached}/{total} requests)",
          {
            rate: analytics.requests.cacheHitRate,
            cached: cachedRequests,
            total: allRequests,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

// Helper function
function getDateMinutesAgo(minutes: number): string {
  const date = new Date(Date.now() + minutes * 60 * 1000);
  return date.toISOString().split("T")[0];
}
