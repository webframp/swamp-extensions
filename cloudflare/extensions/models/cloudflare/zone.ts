// Cloudflare Zone Management
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { z } from "npm:zod@4";
import { cfApi, cfApiPaginated } from "./_lib/api.ts";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  apiToken: z.string().meta({ sensitive: true }).describe(
    "Cloudflare API token with Zone read/write permissions",
  ),
});

const ZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  paused: z.boolean(),
  type: z.string(),
  development_mode: z.number(),
  name_servers: z.array(z.string()),
  original_name_servers: z.array(z.string()).optional(),
  plan: z.object({
    id: z.string(),
    name: z.string(),
  }).optional(),
  account: z.object({
    id: z.string(),
    name: z.string(),
  }),
  created_on: z.string(),
  modified_on: z.string(),
});

const ZoneListSchema = z.object({
  zones: z.array(ZoneSchema),
  fetchedAt: z.string(),
});

const ZoneSettingsSchema = z.object({
  zoneId: z.string(),
  zoneName: z.string(),
  settings: z.record(z.string(), z.unknown()),
  fetchedAt: z.string(),
});

// =============================================================================
// Model Definition
// =============================================================================

export const model = {
  type: "@webframp/cloudflare/zone",
  version: "2026.03.28.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    "zones": {
      description: "List of all zones in the account",
      schema: ZoneListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "zone": {
      description: "Single zone details",
      schema: ZoneSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "settings": {
      description: "Zone settings (caching, SSL, etc.)",
      schema: ZoneSettingsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    list: {
      description: "List all zones in the account",
      arguments: z.object({
        status: z.enum([
          "active",
          "pending",
          "initializing",
          "moved",
          "deleted",
          "deactivated",
        ]).optional()
          .describe("Filter by zone status"),
      }),
      execute: async (
        args: { status?: string },
        context: {
          globalArgs: { apiToken: string };
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
        const { apiToken } = context.globalArgs;
        const params: Record<string, string> = {};
        if (args.status) params.status = args.status;

        const zones = await cfApiPaginated<z.infer<typeof ZoneSchema>>(
          apiToken,
          "/zones",
          params,
        );

        const handle = await context.writeResource("zones", "main", {
          zones,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} zones", { count: zones.length });
        return { dataHandles: [handle] };
      },
    },

    get: {
      description: "Get details for a specific zone",
      arguments: z.object({
        zoneId: z.string().describe("Zone ID"),
      }),
      execute: async (
        args: { zoneId: string },
        context: {
          globalArgs: { apiToken: string };
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
        const { apiToken } = context.globalArgs;
        const zone = await cfApi<z.infer<typeof ZoneSchema>>(
          apiToken,
          "GET",
          `/zones/${args.zoneId}`,
        );

        const handle = await context.writeResource("zone", args.zoneId, zone);
        context.logger.info("Fetched zone {name}", { name: zone.name });
        return { dataHandles: [handle] };
      },
    },

    get_settings: {
      description: "Get all settings for a zone",
      arguments: z.object({
        zoneId: z.string().describe("Zone ID"),
      }),
      execute: async (
        args: { zoneId: string },
        context: {
          globalArgs: { apiToken: string };
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
        const { apiToken } = context.globalArgs;

        // Fetch zone name for context
        const zone = await cfApi<{ name: string }>(
          apiToken,
          "GET",
          `/zones/${args.zoneId}`,
        );

        // Fetch all settings
        const settingsArray = await cfApi<
          Array<{ id: string; value: unknown }>
        >(
          apiToken,
          "GET",
          `/zones/${args.zoneId}/settings`,
        );

        // Convert to record for easier access
        const settings: Record<string, unknown> = {};
        for (const s of settingsArray) {
          settings[s.id] = s.value;
        }

        const handle = await context.writeResource("settings", args.zoneId, {
          zoneId: args.zoneId,
          zoneName: zone.name,
          settings,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Fetched {count} settings for zone {name}", {
          count: settingsArray.length,
          name: zone.name,
        });
        return { dataHandles: [handle] };
      },
    },

    update_setting: {
      description: "Update a specific zone setting",
      arguments: z.object({
        zoneId: z.string().describe("Zone ID"),
        setting: z.string().describe(
          "Setting name (e.g., 'ssl', 'cache_level', 'minify')",
        ),
        value: z.unknown().describe("New value for the setting"),
      }),
      execute: async (
        args: { zoneId: string; setting: string; value: unknown },
        context: {
          globalArgs: { apiToken: string };
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
        const { apiToken } = context.globalArgs;

        await cfApi(
          apiToken,
          "PATCH",
          `/zones/${args.zoneId}/settings/${args.setting}`,
          { value: args.value },
        );

        // Fetch updated settings
        const settingsArray = await cfApi<
          Array<{ id: string; value: unknown }>
        >(
          apiToken,
          "GET",
          `/zones/${args.zoneId}/settings`,
        );

        const settings: Record<string, unknown> = {};
        for (const s of settingsArray) {
          settings[s.id] = s.value;
        }

        const zone = await cfApi<{ name: string }>(
          apiToken,
          "GET",
          `/zones/${args.zoneId}`,
        );

        const handle = await context.writeResource("settings", args.zoneId, {
          zoneId: args.zoneId,
          zoneName: zone.name,
          settings,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Updated setting {setting} for zone {zoneId}", {
          setting: args.setting,
          zoneId: args.zoneId,
        });
        return { dataHandles: [handle] };
      },
    },

    pause: {
      description: "Pause a zone (disable Cloudflare proxy)",
      arguments: z.object({
        zoneId: z.string().describe("Zone ID"),
      }),
      execute: async (
        args: { zoneId: string },
        context: {
          globalArgs: { apiToken: string };
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
        const { apiToken } = context.globalArgs;

        const zone = await cfApi<z.infer<typeof ZoneSchema>>(
          apiToken,
          "PATCH",
          `/zones/${args.zoneId}`,
          { paused: true },
        );

        const handle = await context.writeResource("zone", args.zoneId, zone);
        context.logger.info("Paused zone {name}", { name: zone.name });
        return { dataHandles: [handle] };
      },
    },

    unpause: {
      description: "Unpause a zone (enable Cloudflare proxy)",
      arguments: z.object({
        zoneId: z.string().describe("Zone ID"),
      }),
      execute: async (
        args: { zoneId: string },
        context: {
          globalArgs: { apiToken: string };
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
        const { apiToken } = context.globalArgs;

        const zone = await cfApi<z.infer<typeof ZoneSchema>>(
          apiToken,
          "PATCH",
          `/zones/${args.zoneId}`,
          { paused: false },
        );

        const handle = await context.writeResource("zone", args.zoneId, zone);
        context.logger.info("Unpaused zone {name}", { name: zone.name });
        return { dataHandles: [handle] };
      },
    },
  },
};
