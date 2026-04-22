/**
 * Cloudflare DNS Record Management model for swamp.
 *
 * Provides full CRUD operations for DNS records within a Cloudflare zone,
 * including listing, creating, updating, deleting, and exporting records
 * in BIND zone-file format.
 *
 * @module
 */
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { z } from "npm:zod@4";
import { cfApi, cfApiPaginated } from "./_lib/api.ts";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  apiToken: z.string().meta({ sensitive: true }).describe(
    "Cloudflare API token with DNS read/write permissions",
  ),
  zoneId: z.string().describe("Zone ID to manage DNS records for"),
});

const DnsRecordSchema = z.object({
  id: z.string(),
  zone_id: z.string(),
  zone_name: z.string(),
  name: z.string(),
  type: z.string(),
  content: z.string(),
  proxiable: z.boolean(),
  proxied: z.boolean(),
  ttl: z.number(),
  locked: z.boolean(),
  priority: z.number().optional(),
  created_on: z.string(),
  modified_on: z.string(),
  comment: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
});

const DnsRecordListSchema = z.object({
  zoneId: z.string(),
  records: z.array(DnsRecordSchema),
  fetchedAt: z.string(),
});

// =============================================================================
// Model Definition
// =============================================================================

/** Cloudflare DNS model definition with full CRUD methods and BIND-format export. */
export const model = {
  type: "@webframp/cloudflare/dns",
  version: "2026.03.28.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    "records": {
      description: "List of DNS records for the zone",
      schema: DnsRecordListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "record": {
      description: "Single DNS record",
      schema: DnsRecordSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    list: {
      description: "List all DNS records in the zone",
      arguments: z.object({
        type: z.enum([
          "A",
          "AAAA",
          "CNAME",
          "TXT",
          "MX",
          "NS",
          "SRV",
          "CAA",
          "PTR",
        ]).optional()
          .describe("Filter by record type"),
        name: z.string().optional().describe(
          "Filter by record name (exact match)",
        ),
      }),
      execute: async (
        args: { type?: string; name?: string },
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
        const params: Record<string, string> = {};
        if (args.type) params.type = args.type;
        if (args.name) params.name = args.name;

        const records = await cfApiPaginated<z.infer<typeof DnsRecordSchema>>(
          apiToken,
          `/zones/${zoneId}/dns_records`,
          params,
        );

        const handle = await context.writeResource("records", "main", {
          zoneId,
          records,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} DNS records", {
          count: records.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get: {
      description: "Get a specific DNS record",
      arguments: z.object({
        recordId: z.string().describe("DNS record ID"),
      }),
      execute: async (
        args: { recordId: string },
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

        const record = await cfApi<z.infer<typeof DnsRecordSchema>>(
          apiToken,
          "GET",
          `/zones/${zoneId}/dns_records/${args.recordId}`,
        );

        const handle = await context.writeResource(
          "record",
          args.recordId,
          record,
        );
        context.logger.info("Fetched DNS record {name} ({type})", {
          name: record.name,
          type: record.type,
        });
        return { dataHandles: [handle] };
      },
    },

    create: {
      description: "Create a new DNS record",
      arguments: z.object({
        type: z.enum([
          "A",
          "AAAA",
          "CNAME",
          "TXT",
          "MX",
          "NS",
          "SRV",
          "CAA",
          "PTR",
        ])
          .describe("Record type"),
        name: z.string().describe("Record name (e.g., 'www' or '@' for root)"),
        content: z.string().describe(
          "Record content (IP address, hostname, etc.)",
        ),
        ttl: z.number().default(1).describe("TTL in seconds (1 = auto)"),
        proxied: z.boolean().default(false).describe(
          "Enable Cloudflare proxy (orange cloud)",
        ),
        priority: z.number().optional().describe(
          "Priority (required for MX records)",
        ),
        comment: z.string().optional().describe("Comment for the record"),
      }),
      execute: async (
        args: {
          type: string;
          name: string;
          content: string;
          ttl: number;
          proxied: boolean;
          priority?: number;
          comment?: string;
        },
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

        const body: Record<string, unknown> = {
          type: args.type,
          name: args.name,
          content: args.content,
          ttl: args.ttl,
          proxied: args.proxied,
        };
        if (args.priority !== undefined) body.priority = args.priority;
        if (args.comment) body.comment = args.comment;

        const record = await cfApi<z.infer<typeof DnsRecordSchema>>(
          apiToken,
          "POST",
          `/zones/${zoneId}/dns_records`,
          body,
        );

        const handle = await context.writeResource("record", record.id, record);
        context.logger.info("Created DNS record {name} ({type}) -> {content}", {
          name: record.name,
          type: record.type,
          content: record.content,
        });
        return { dataHandles: [handle] };
      },
    },

    update: {
      description: "Update an existing DNS record",
      arguments: z.object({
        recordId: z.string().describe("DNS record ID to update"),
        type: z.enum([
          "A",
          "AAAA",
          "CNAME",
          "TXT",
          "MX",
          "NS",
          "SRV",
          "CAA",
          "PTR",
        ])
          .describe("Record type"),
        name: z.string().describe("Record name"),
        content: z.string().describe("Record content"),
        ttl: z.number().default(1).describe("TTL in seconds (1 = auto)"),
        proxied: z.boolean().default(false).describe("Enable Cloudflare proxy"),
        priority: z.number().optional().describe("Priority (for MX records)"),
        comment: z.string().optional().describe("Comment for the record"),
      }),
      execute: async (
        args: {
          recordId: string;
          type: string;
          name: string;
          content: string;
          ttl: number;
          proxied: boolean;
          priority?: number;
          comment?: string;
        },
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

        const body: Record<string, unknown> = {
          type: args.type,
          name: args.name,
          content: args.content,
          ttl: args.ttl,
          proxied: args.proxied,
        };
        if (args.priority !== undefined) body.priority = args.priority;
        if (args.comment) body.comment = args.comment;

        const record = await cfApi<z.infer<typeof DnsRecordSchema>>(
          apiToken,
          "PUT",
          `/zones/${zoneId}/dns_records/${args.recordId}`,
          body,
        );

        const handle = await context.writeResource("record", record.id, record);
        context.logger.info("Updated DNS record {name} ({type})", {
          name: record.name,
          type: record.type,
        });
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a DNS record",
      arguments: z.object({
        recordId: z.string().describe("DNS record ID to delete"),
      }),
      execute: async (
        args: { recordId: string },
        context: {
          globalArgs: { apiToken: string; zoneId: string };
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, zoneId } = context.globalArgs;

        await cfApi(
          apiToken,
          "DELETE",
          `/zones/${zoneId}/dns_records/${args.recordId}`,
        );

        context.logger.info("Deleted DNS record {recordId}", {
          recordId: args.recordId,
        });
        return { dataHandles: [] };
      },
    },

    export: {
      description: "Export all DNS records in BIND format",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: { apiToken: string; zoneId: string };
          createFileWriter: (
            spec: string,
            instance: string,
          ) => { writeText: (content: string) => Promise<{ name: string }> };
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, zoneId } = context.globalArgs;

        const response = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/export`,
          {
            headers: {
              "Authorization": `Bearer ${apiToken}`,
            },
          },
        );

        if (!response.ok) {
          throw new Error(
            `Failed to export DNS records: ${response.statusText}`,
          );
        }

        const bindContent = await response.text();

        const writer = context.createFileWriter("export", "bind");
        const handle = await writer.writeText(bindContent);

        context.logger.info("Exported DNS records in BIND format", {});
        return { dataHandles: [handle] };
      },
    },
  },

  files: {
    "export": {
      description: "DNS records exported in BIND zone file format",
      contentType: "text/plain",
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
};
