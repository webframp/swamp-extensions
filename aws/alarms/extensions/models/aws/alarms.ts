/**
 * AWS CloudWatch Alarms operations model for swamp.
 *
 * Provides methods to list, filter, and summarize CloudWatch Alarms,
 * retrieve alarm state-change history, and identify active alerts
 * for operational visibility and incident response.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";
import {
  type AlarmHistoryItem,
  CloudWatchClient,
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
  type MetricAlarm,
} from "npm:@aws-sdk/client-cloudwatch@3.1120.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1120.0";

const EXTENSION_NAME = "@webframp/aws/alarms";

const MAX_PAGES = 10;

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region for CloudWatch Alarms"),
  profile: z
    .string()
    .min(1)
    .optional()
    .describe(
      "AWS shared-config profile to resolve credentials from (fromIni / SSO " +
        "token cache). Omit to use the default credential chain.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/**
 * Build base AWS client configuration with region and optional profile credentials.
 * When `profile` is set, credentials resolve via fromIni (supports SSO token
 * cache and shared config). When absent, the default credential chain applies.
 */
function makeClientConfig(
  globalArgs: GlobalArgs,
): { region: string; credentials?: ReturnType<typeof fromIni> } {
  return {
    region: globalArgs.region,
    ...(globalArgs.profile
      ? { credentials: fromIni({ profile: globalArgs.profile }) }
      : {}),
  };
}

const AlarmSchema = z.object({
  alarmName: z.string(),
  alarmArn: z.string().nullable(),
  alarmDescription: z.string().nullable(),
  stateValue: z.enum(["OK", "ALARM", "INSUFFICIENT_DATA"]),
  stateReason: z.string().nullable(),
  stateUpdatedTimestamp: z.string().nullable(),
  metricName: z.string().nullable(),
  namespace: z.string().nullable(),
  threshold: z.number().nullable(),
  comparisonOperator: z.string().nullable(),
  evaluationPeriods: z.number().nullable(),
  dimensions: z.array(z.object({
    name: z.string(),
    value: z.string(),
  })),
  actionsEnabled: z.boolean(),
  alarmActions: z.array(z.string()),
});

const AlarmListSchema = z.object({
  alarms: z.array(AlarmSchema),
  count: z.number(),
  stateFilter: z.string().nullable(),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const AlarmHistoryEntrySchema = z.object({
  alarmName: z.string(),
  timestamp: z.string(),
  historyItemType: z.string(),
  historySummary: z.string(),
  historyData: z.string().nullable(),
});

const AlarmHistorySchema = z.object({
  alarmName: z.string().nullable(),
  entries: z.array(AlarmHistoryEntrySchema),
  count: z.number(),
  timeRange: z.object({
    start: z.string(),
    end: z.string(),
  }),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const AlarmSummarySchema = z.object({
  total: z.number(),
  inAlarm: z.number(),
  ok: z.number(),
  insufficientData: z.number(),
  byNamespace: z.record(z.string(), z.number()),
  recentStateChanges: z.array(z.object({
    alarmName: z.string(),
    previousState: z.string(),
    currentState: z.string(),
    timestamp: z.string(),
  })),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

// =============================================================================
// Helper Functions
// =============================================================================

function parseRelativeTime(timeStr: string): Date {
  const now = new Date();

  const match = timeStr.match(/^(\d+)([mhd])$/);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case "m":
        return new Date(now.getTime() - value * 60 * 1000);
      case "h":
        return new Date(now.getTime() - value * 60 * 60 * 1000);
      case "d":
        return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
    }
  }

  const parsed = new Date(timeStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

interface AwsDimension {
  Name?: string;
  Value?: string;
}

// =============================================================================
// Model Definition
// =============================================================================

/**
 * CloudWatch Alarms model definition.
 *
 * Exposes four methods: `list_alarms`, `get_active`, `get_history`,
 * and `get_summary` for querying and analyzing alarm state across
 * an AWS account.
 */
export const model = {
  type: "@webframp/aws/alarms",
  version: "2026.08.28.1",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.07.30.1",
      description: "Add optional profile global argument for multi-account use",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.05.1",
      description: "Version bump, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.20.1",
      description: "Dependency bump, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.1",
      description:
        "Error-message quality pass: no schema changes to stored resources",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.24.2",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },

    {
      toVersion: "2026.08.24.3",

      description:
        "Added optional durationMs, collectedBy, and fetchedAt output metadata fields",

      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.25.1",
      description: "Label metadata update, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.1",
      description: "Fix missing upgrade description metadata",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.2",
      description:
        "No schema changes — restored inline npm:zod specifier for registry scoring; retained strict mode",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.28.1",
      description:
        "No schema changes — restored inline npm:zod specifier for registry scoring; retained strict mode",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    alarm_list: {
      description: "List of CloudWatch alarms",
      schema: AlarmListSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    alarm_history: {
      description: "Alarm state change history",
      schema: AlarmHistorySchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    alarm_summary: {
      description: "Summary of alarm states",
      schema: AlarmSummarySchema,
      lifetime: "15m" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    list_alarms: {
      description:
        "List CloudWatch alarms with optional state and name prefix filters",
      arguments: z.object({
        stateValue: z
          .enum(["OK", "ALARM", "INSUFFICIENT_DATA"])
          .optional()
          .describe("Filter by alarm state"),
        alarmNamePrefix: z
          .string()
          .optional()
          .describe("Filter by alarm name prefix"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .default(100)
          .describe("Maximum number of alarms to return"),
      }),
      execute: async (
        args: {
          stateValue?: "OK" | "ALARM" | "INSUFFICIENT_DATA";
          alarmNamePrefix?: string;
          limit: number;
        },
        context: {
          globalArgs: GlobalArgs;
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
        const startMs = Date.now();
        const client = new CloudWatchClient(
          makeClientConfig(context.globalArgs),
        );
        try {
          const alarms: z.infer<typeof AlarmSchema>[] = [];
          let nextToken: string | undefined;

          do {
            const command = new DescribeAlarmsCommand({
              StateValue: args.stateValue,
              AlarmNamePrefix: args.alarmNamePrefix,
              NextToken: nextToken,
              MaxRecords: Math.min(100, args.limit - alarms.length),
            });
            let response;
            try {
              response = await client.send(command);
            } catch (err) {
              throw new Error(
                `DescribeAlarms failed (region=${context.globalArgs.region}` +
                  `${
                    args.stateValue ? `, stateValue=${args.stateValue}` : ""
                  }` +
                  `${
                    args.alarmNamePrefix
                      ? `, alarmNamePrefix=${args.alarmNamePrefix}`
                      : ""
                  }): ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              );
            }

            if (response.MetricAlarms) {
              for (const alarm of response.MetricAlarms) {
                if (alarms.length >= args.limit) break;
                alarms.push(mapAlarm(alarm));
              }
            }

            nextToken = response.NextToken;
          } while (nextToken && alarms.length < args.limit);

          const instanceName = args.stateValue
            ? `state-${args.stateValue.toLowerCase()}`
            : args.alarmNamePrefix
            ? `prefix-${args.alarmNamePrefix.replace(/[\/\s]/g, "-")}`
            : "all";

          const handle = await context.writeResource(
            "alarm_list",
            instanceName,
            {
              alarms,
              count: alarms.length,
              stateFilter: args.stateValue || null,
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            },
          );

          context.logger.info("Found {count} alarms", { count: alarms.length });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    get_active: {
      description:
        "Get all alarms currently in ALARM state (convenience method)",
      arguments: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .default(50)
          .describe("Maximum number of alarms to return"),
      }),
      execute: async (
        args: { limit: number },
        context: {
          globalArgs: GlobalArgs;
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
        const startMs = Date.now();
        const client = new CloudWatchClient(
          makeClientConfig(context.globalArgs),
        );
        try {
          const alarms: z.infer<typeof AlarmSchema>[] = [];
          let nextToken: string | undefined;

          do {
            const command = new DescribeAlarmsCommand({
              StateValue: "ALARM",
              NextToken: nextToken,
              MaxRecords: Math.min(100, args.limit - alarms.length),
            });
            let response;
            try {
              response = await client.send(command);
            } catch (err) {
              throw new Error(
                `DescribeAlarms failed (region=${context.globalArgs.region}, ` +
                  `stateValue=ALARM): ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                { cause: err },
              );
            }

            if (response.MetricAlarms) {
              for (const alarm of response.MetricAlarms) {
                if (alarms.length >= args.limit) break;
                alarms.push(mapAlarm(alarm));
              }
            }

            nextToken = response.NextToken;
          } while (nextToken && alarms.length < args.limit);

          const handle = await context.writeResource("alarm_list", "active", {
            alarms,
            count: alarms.length,
            stateFilter: "ALARM",
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          });

          context.logger.info("Found {count} active alarms", {
            count: alarms.length,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    get_history: {
      description: "Get alarm state change history",
      arguments: z.object({
        alarmName: z
          .string()
          .optional()
          .describe("Specific alarm name (optional, returns all if not set)"),
        historyItemType: z
          .enum(["ConfigurationUpdate", "StateUpdate", "Action"])
          .optional()
          .describe("Filter by history item type"),
        startTime: z
          .string()
          .default("24h")
          .describe("Start time (ISO date or relative: 1h, 30m, 2d)"),
        endTime: z
          .string()
          .optional()
          .describe("End time (ISO date, defaults to now)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .default(100)
          .describe("Maximum number of history entries to return"),
      }),
      execute: async (
        args: {
          alarmName?: string;
          historyItemType?:
            | "ConfigurationUpdate"
            | "StateUpdate"
            | "Action";
          startTime: string;
          endTime?: string;
          limit: number;
        },
        context: {
          globalArgs: GlobalArgs;
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
        const startMs = Date.now();
        const client = new CloudWatchClient(
          makeClientConfig(context.globalArgs),
        );
        try {
          const startTime = parseRelativeTime(args.startTime);
          const endTime = args.endTime
            ? parseRelativeTime(args.endTime)
            : new Date();

          const entries: z.infer<typeof AlarmHistoryEntrySchema>[] = [];
          let nextToken: string | undefined;

          do {
            const command = new DescribeAlarmHistoryCommand({
              AlarmName: args.alarmName,
              HistoryItemType: args.historyItemType,
              StartDate: startTime,
              EndDate: endTime,
              NextToken: nextToken,
              MaxRecords: Math.min(100, args.limit - entries.length),
            });
            let response;
            try {
              response = await client.send(command);
            } catch (err) {
              throw new Error(
                `DescribeAlarmHistory failed (region=${context.globalArgs.region}${
                  args.alarmName ? `, alarmName=${args.alarmName}` : ""
                }): ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              );
            }

            if (response.AlarmHistoryItems) {
              for (const item of response.AlarmHistoryItems) {
                if (entries.length >= args.limit) break;
                entries.push(mapHistoryItem(item));
              }
            }

            nextToken = response.NextToken;
          } while (nextToken && entries.length < args.limit);

          const instanceName = args.alarmName
            ? `history-${args.alarmName.replace(/[\/\s]/g, "-")}`
            : "history-all";

          const handle = await context.writeResource(
            "alarm_history",
            instanceName,
            {
              alarmName: args.alarmName || null,
              entries,
              count: entries.length,
              timeRange: {
                start: startTime.toISOString(),
                end: endTime.toISOString(),
              },
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            },
          );

          context.logger.info("Found {count} history entries", {
            count: entries.length,
          });
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },

    get_summary: {
      description:
        "Get a summary of all alarms including state counts and recent changes",
      arguments: z.object({
        startTime: z
          .string()
          .optional()
          .describe(
            "Start time for recent changes (ISO date or relative: 1h, 30m, 2d). Overrides historyHours when set.",
          ),
        historyHours: z
          .number()
          .positive()
          .max(24 * 30)
          .default(6)
          .describe("Hours to look back for recent state changes"),
      }),
      execute: async (
        args: { startTime?: string; historyHours: number },
        context: {
          globalArgs: GlobalArgs;
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
        const startMs = Date.now();
        const client = new CloudWatchClient(
          makeClientConfig(context.globalArgs),
        );
        try {
          // Get all alarms
          const allAlarms: MetricAlarm[] = [];
          let nextToken: string | undefined;
          let pages = 0;

          do {
            const command = new DescribeAlarmsCommand({
              NextToken: nextToken,
              MaxRecords: 100,
            });
            let response;
            try {
              response = await client.send(command);
            } catch (err) {
              throw new Error(
                `DescribeAlarms failed while building summary (region=${context.globalArgs.region}, page=${pages}): ${
                  err instanceof Error ? err.message : String(err)
                }`,
                { cause: err },
              );
            }

            if (response.MetricAlarms) {
              allAlarms.push(...response.MetricAlarms);
            }

            nextToken = response.NextToken;
            pages++;
          } while (nextToken && pages < MAX_PAGES);

          // Count states
          let inAlarm = 0;
          let ok = 0;
          let insufficientData = 0;
          const byNamespace: Record<string, number> = {};

          for (const alarm of allAlarms) {
            switch (alarm.StateValue) {
              case "ALARM":
                inAlarm++;
                break;
              case "OK":
                ok++;
                break;
              case "INSUFFICIENT_DATA":
                insufficientData++;
                break;
            }

            const ns = alarm.Namespace || "Unknown";
            byNamespace[ns] = (byNamespace[ns] || 0) + 1;
          }

          // Get recent state changes
          const startTime = args.startTime
            ? parseRelativeTime(args.startTime)
            : new Date(Date.now() - args.historyHours * 60 * 60 * 1000);
          const recentChanges: Array<{
            alarmName: string;
            previousState: string;
            currentState: string;
            timestamp: string;
          }> = [];

          const historyCommand = new DescribeAlarmHistoryCommand({
            HistoryItemType: "StateUpdate",
            StartDate: startTime,
            EndDate: new Date(),
            MaxRecords: 50,
          });
          let historyResponse;
          try {
            historyResponse = await client.send(historyCommand);
          } catch (err) {
            throw new Error(
              `DescribeAlarmHistory failed while building summary (region=${context.globalArgs.region}, since=${startTime.toISOString()}): ${
                err instanceof Error ? err.message : String(err)
              }`,
              { cause: err },
            );
          }

          if (historyResponse.AlarmHistoryItems) {
            for (const item of historyResponse.AlarmHistoryItems) {
              if (item.AlarmName && item.Timestamp && item.HistoryData) {
                try {
                  const data = JSON.parse(item.HistoryData);
                  recentChanges.push({
                    alarmName: item.AlarmName,
                    previousState: data.oldState?.stateValue || "unknown",
                    currentState: data.newState?.stateValue || "unknown",
                    timestamp: item.Timestamp.toISOString(),
                  });
                } catch {
                  // Skip malformed history data
                }
              }
            }
          }

          const handle = await context.writeResource(
            "alarm_summary",
            "summary",
            {
              total: allAlarms.length,
              inAlarm,
              ok,
              insufficientData,
              byNamespace,
              recentStateChanges: recentChanges,
              fetchedAt: new Date().toISOString(),
              durationMs: Date.now() - startMs,
              collectedBy: EXTENSION_NAME,
            },
          );

          context.logger.info(
            "Summary: {total} alarms ({inAlarm} in ALARM, {ok} OK, {insufficient} INSUFFICIENT_DATA)",
            {
              total: allAlarms.length,
              inAlarm,
              ok,
              insufficient: insufficientData,
            },
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
      },
    },
  },
};

// =============================================================================
// Helper Functions for Mapping
// =============================================================================

function mapAlarm(alarm: MetricAlarm): z.infer<typeof AlarmSchema> {
  return {
    alarmName: alarm.AlarmName || "",
    alarmArn: alarm.AlarmArn || null,
    alarmDescription: alarm.AlarmDescription || null,
    stateValue: (alarm.StateValue as "OK" | "ALARM" | "INSUFFICIENT_DATA") ||
      "INSUFFICIENT_DATA",
    stateReason: alarm.StateReason || null,
    stateUpdatedTimestamp: alarm.StateUpdatedTimestamp?.toISOString() || null,
    metricName: alarm.MetricName || null,
    namespace: alarm.Namespace || null,
    threshold: alarm.Threshold ?? null,
    comparisonOperator: alarm.ComparisonOperator || null,
    evaluationPeriods: alarm.EvaluationPeriods ?? null,
    dimensions: (alarm.Dimensions || []).map((d: AwsDimension) => ({
      name: d.Name || "",
      value: d.Value || "",
    })),
    actionsEnabled: alarm.ActionsEnabled ?? false,
    alarmActions: alarm.AlarmActions || [],
  };
}

function mapHistoryItem(
  item: AlarmHistoryItem,
): z.infer<typeof AlarmHistoryEntrySchema> {
  return {
    alarmName: item.AlarmName || "",
    timestamp: item.Timestamp?.toISOString() || "",
    historyItemType: item.HistoryItemType || "",
    historySummary: item.HistorySummary || "",
    historyData: item.HistoryData || null,
  };
}
