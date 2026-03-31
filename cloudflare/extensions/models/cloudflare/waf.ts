// Cloudflare WAF / Firewall Rules Management
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { z } from "npm:zod@4";
import { cfApi, cfApiPaginated } from "./_lib/api.ts";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  apiToken: z.string().meta({ sensitive: true }).describe(
    "Cloudflare API token with Firewall read/write permissions",
  ),
  zoneId: z.string().describe("Zone ID to manage firewall rules for"),
});

const FirewallRuleSchema = z.object({
  id: z.string(),
  paused: z.boolean(),
  description: z.string().optional(),
  action: z.string(),
  priority: z.number().optional(),
  filter: z.object({
    id: z.string(),
    expression: z.string(),
    paused: z.boolean(),
  }),
  created_on: z.string(),
  modified_on: z.string(),
});

const FirewallRuleListSchema = z.object({
  zoneId: z.string(),
  rules: z.array(FirewallRuleSchema),
  fetchedAt: z.string(),
});

const WafPackageSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  zone_id: z.string(),
  detection_mode: z.string(),
  sensitivity: z.string().optional(),
  action_mode: z.string().optional(),
});

const WafPackageListSchema = z.object({
  zoneId: z.string(),
  packages: z.array(WafPackageSchema),
  fetchedAt: z.string(),
});

const SecurityEventSchema = z.object({
  rayId: z.string().optional(),
  action: z.string(),
  source: z.string(),
  clientIP: z.string(),
  userAgent: z.string().optional(),
  host: z.string(),
  uri: z.string(),
  country: z.string().optional(),
  datetime: z.string(),
  ruleId: z.string().optional(),
  ruleMessage: z.string().optional(),
});

const SecurityEventsSchema = z.object({
  zoneId: z.string(),
  events: z.array(SecurityEventSchema),
  fetchedAt: z.string(),
});

// =============================================================================
// Model Definition
// =============================================================================

export const model = {
  type: "@webframp/cloudflare/waf",
  version: "2026.03.28.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    "rules": {
      description: "Firewall rules for the zone",
      schema: FirewallRuleListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "rule": {
      description: "Single firewall rule",
      schema: FirewallRuleSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "packages": {
      description: "WAF packages (managed rulesets)",
      schema: WafPackageListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "events": {
      description: "Recent security events",
      schema: SecurityEventsSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    list_rules: {
      description: "List all firewall rules",
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

        const rules = await cfApiPaginated<z.infer<typeof FirewallRuleSchema>>(
          apiToken,
          `/zones/${zoneId}/firewall/rules`,
        );

        const handle = await context.writeResource("rules", "main", {
          zoneId,
          rules,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} firewall rules", {
          count: rules.length,
        });
        return { dataHandles: [handle] };
      },
    },

    create_rule: {
      description: "Create a new firewall rule",
      arguments: z.object({
        expression: z.string().describe(
          "Firewall expression (e.g., 'ip.src eq 1.2.3.4' or 'http.request.uri.path contains \"/admin\"')",
        ),
        action: z.enum([
          "block",
          "challenge",
          "js_challenge",
          "managed_challenge",
          "allow",
          "log",
          "bypass",
        ])
          .describe("Action to take when rule matches"),
        description: z.string().optional().describe(
          "Human-readable description",
        ),
        priority: z.number().optional().describe(
          "Rule priority (lower = higher priority)",
        ),
        paused: z.boolean().default(false).describe(
          "Create rule in paused state",
        ),
      }),
      execute: async (
        args: {
          expression: string;
          action: string;
          description?: string;
          priority?: number;
          paused: boolean;
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

        // Create filter first
        const filterResponse = await cfApi<Array<{ id: string }>>(
          apiToken,
          "POST",
          `/zones/${zoneId}/filters`,
          [{ expression: args.expression, paused: args.paused }],
        );
        const filterId = filterResponse[0].id;

        // Create rule using filter
        const ruleBody: Record<string, unknown> = {
          filter: { id: filterId },
          action: args.action,
          paused: args.paused,
        };
        if (args.description) ruleBody.description = args.description;
        if (args.priority !== undefined) ruleBody.priority = args.priority;

        const rules = await cfApi<z.infer<typeof FirewallRuleSchema>[]>(
          apiToken,
          "POST",
          `/zones/${zoneId}/firewall/rules`,
          [ruleBody],
        );

        const rule = rules[0];
        const handle = await context.writeResource("rule", rule.id, rule);

        context.logger.info(
          "Created firewall rule: {action} when {expression}",
          {
            action: args.action,
            expression: args.expression,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    delete_rule: {
      description: "Delete a firewall rule",
      arguments: z.object({
        ruleId: z.string().describe("Firewall rule ID to delete"),
      }),
      execute: async (
        args: { ruleId: string },
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
          `/zones/${zoneId}/firewall/rules/${args.ruleId}`,
        );

        context.logger.info("Deleted firewall rule {ruleId}", {
          ruleId: args.ruleId,
        });
        return { dataHandles: [] };
      },
    },

    toggle_rule: {
      description: "Pause or unpause a firewall rule",
      arguments: z.object({
        ruleId: z.string().describe("Firewall rule ID"),
        paused: z.boolean().describe("Set to true to pause, false to enable"),
      }),
      execute: async (
        args: { ruleId: string; paused: boolean },
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

        const rules = await cfApi<z.infer<typeof FirewallRuleSchema>[]>(
          apiToken,
          "PUT",
          `/zones/${zoneId}/firewall/rules/${args.ruleId}`,
          { paused: args.paused },
        );

        const rule = rules[0];
        const handle = await context.writeResource("rule", rule.id, rule);

        const status = args.paused ? "paused" : "enabled";
        context.logger.info("Firewall rule {ruleId} {status}", {
          ruleId: args.ruleId,
          status,
        });
        return { dataHandles: [handle] };
      },
    },

    list_packages: {
      description: "List WAF packages (managed rulesets)",
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

        const packages = await cfApiPaginated<z.infer<typeof WafPackageSchema>>(
          apiToken,
          `/zones/${zoneId}/firewall/waf/packages`,
        );

        const handle = await context.writeResource("packages", "main", {
          zoneId,
          packages,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} WAF packages", {
          count: packages.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_security_events: {
      description: "Get recent security events (blocks, challenges, etc.)",
      arguments: z.object({
        limit: z.number().default(100).describe(
          "Maximum number of events to fetch",
        ),
      }),
      execute: async (
        args: { limit: number },
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

        // Use GraphQL API for security events
        const query = `
          query {
            viewer {
              zones(filter: { zoneTag: "${zoneId}" }) {
                firewallEventsAdaptive(
                  limit: ${args.limit}
                  orderBy: [datetime_DESC]
                ) {
                  rayName
                  action
                  source
                  clientIP
                  userAgent
                  clientRequestHTTPHost
                  clientRequestPath
                  clientCountryName
                  datetime
                  ruleId
                  description
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
                firewallEventsAdaptive?: Array<{
                  rayName?: string;
                  action: string;
                  source: string;
                  clientIP: string;
                  userAgent?: string;
                  clientRequestHTTPHost: string;
                  clientRequestPath: string;
                  clientCountryName?: string;
                  datetime: string;
                  ruleId?: string;
                  description?: string;
                }>;
              }>;
            };
          };
        };

        const rawEvents =
          data.data?.viewer?.zones?.[0]?.firewallEventsAdaptive ?? [];

        const events = rawEvents.map((e) => ({
          rayId: e.rayName,
          action: e.action,
          source: e.source,
          clientIP: e.clientIP,
          userAgent: e.userAgent,
          host: e.clientRequestHTTPHost,
          uri: e.clientRequestPath,
          country: e.clientCountryName,
          datetime: e.datetime,
          ruleId: e.ruleId,
          ruleMessage: e.description,
        }));

        const handle = await context.writeResource("events", "recent", {
          zoneId,
          events,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Fetched {count} security events", {
          count: events.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
