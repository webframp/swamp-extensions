/**
 * AWS CloudWatch Logs operations model for swamp.
 *
 * Provides methods to query and analyze CloudWatch Logs, including log group
 * discovery, Logs Insights queries, error pattern analysis, and recent event
 * filtering. Uses the AWS SDK v3 CloudWatch Logs client with the default
 * credential chain.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
  GetQueryResultsCommand,
  StartQueryCommand,
} from "npm:@aws-sdk/client-cloudwatch-logs@3.1010.0";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region for CloudWatch Logs"),
});

const LogGroupSchema = z.object({
  name: z.string(),
  arn: z.string().nullable(),
  creationTime: z.string().nullable(),
  retentionDays: z.number().nullable(),
  storedBytes: z.number().nullable(),
  logGroupClass: z.string().nullable(),
});

const LogGroupListSchema = z.object({
  logGroups: z.array(LogGroupSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const LogEventSchema = z.object({
  timestamp: z.string(),
  message: z.string(),
  logStreamName: z.string().nullable(),
});

const LogQueryResultSchema = z.object({
  queryId: z.string(),
  status: z.string(),
  results: z.array(z.record(z.string(), z.string())),
  statistics: z.object({
    recordsMatched: z.number(),
    recordsScanned: z.number(),
    bytesScanned: z.number(),
  }).nullable(),
  fetchedAt: z.string(),
});

const ErrorPatternSchema = z.object({
  pattern: z.string(),
  count: z.number(),
  firstOccurrence: z.string().nullable(),
  lastOccurrence: z.string().nullable(),
  sampleMessages: z.array(z.string()),
});

const ErrorAnalysisSchema = z.object({
  logGroupName: z.string(),
  timeRange: z.object({
    start: z.string(),
    end: z.string(),
  }),
  totalErrors: z.number(),
  patterns: z.array(ErrorPatternSchema),
  fetchedAt: z.string(),
});

// =============================================================================
// Helper Functions
// =============================================================================

function parseRelativeTime(timeStr: string): Date {
  const now = new Date();

  // Handle relative times like "1h", "30m", "2d"
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

  // Try parsing as ISO date
  const parsed = new Date(timeStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  // Default to 1 hour ago
  return new Date(now.getTime() - 60 * 60 * 1000);
}

async function waitForQueryCompletion(
  client: CloudWatchLogsClient,
  queryId: string,
  maxWaitMs: number = 30000,
): Promise<{
  status: string;
  results: Array<Record<string, string>>;
  statistics: {
    recordsMatched: number;
    recordsScanned: number;
    bytesScanned: number;
  } | null;
}> {
  const startTime = Date.now();
  let status = "Running";
  let results: Array<Record<string, string>> = [];
  let statistics = null;

  while (Date.now() - startTime < maxWaitMs) {
    const command = new GetQueryResultsCommand({ queryId });
    const response = await client.send(command);

    status = response.status || "Unknown";

    if (
      status === "Complete" || status === "Failed" || status === "Cancelled"
    ) {
      if (response.results) {
        results = response.results.map((row) => {
          const record: Record<string, string> = {};
          for (const field of row) {
            if (field.field && field.value !== undefined) {
              record[field.field] = field.value;
            }
          }
          return record;
        });
      }

      if (response.statistics) {
        statistics = {
          recordsMatched: response.statistics.recordsMatched || 0,
          recordsScanned: response.statistics.recordsScanned || 0,
          bytesScanned: response.statistics.bytesScanned || 0,
        };
      }

      break;
    }

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return { status, results, statistics };
}

// =============================================================================
// Model Definition
// =============================================================================

/**
 * CloudWatch Logs model definition.
 *
 * Exposes four methods -- `list_log_groups`, `query`, `find_errors`, and
 * `get_recent_events` -- backed by the AWS CloudWatch Logs SDK. Each method
 * writes its results to a typed swamp resource for downstream consumption in
 * workflows and reports.
 */
export const model = {
  type: "@webframp/aws/logs",
  version: "2026.03.30.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    log_groups: {
      description: "List of CloudWatch log groups",
      schema: LogGroupListSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    query_results: {
      description: "Results from a Logs Insights query",
      schema: LogQueryResultSchema,
      lifetime: "1d" as const,
      garbageCollection: 20,
    },
    error_analysis: {
      description: "Error pattern analysis results",
      schema: ErrorAnalysisSchema,
      lifetime: "1d" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    list_log_groups: {
      description: "List CloudWatch log groups with optional prefix filter",
      arguments: z.object({
        prefix: z
          .string()
          .optional()
          .describe("Filter log groups by name prefix"),
        limit: z
          .number()
          .default(50)
          .describe("Maximum number of log groups to return"),
      }),
      execute: async (
        args: { prefix?: string; limit: number },
        context: {
          globalArgs: { region: string };
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
        const client = new CloudWatchLogsClient({
          region: context.globalArgs.region,
        });
        const logGroups: z.infer<typeof LogGroupSchema>[] = [];
        let nextToken: string | undefined;

        do {
          const command = new DescribeLogGroupsCommand({
            logGroupNamePrefix: args.prefix,
            nextToken,
            limit: Math.min(50, args.limit - logGroups.length),
          });
          const response = await client.send(command);

          if (response.logGroups) {
            for (const lg of response.logGroups) {
              if (logGroups.length >= args.limit) break;
              logGroups.push({
                name: lg.logGroupName || "",
                arn: lg.arn || null,
                creationTime: lg.creationTime
                  ? new Date(lg.creationTime).toISOString()
                  : null,
                retentionDays: lg.retentionInDays || null,
                storedBytes: lg.storedBytes || null,
                logGroupClass: lg.logGroupClass || null,
              });
            }
          }

          nextToken = response.nextToken;
        } while (nextToken && logGroups.length < args.limit);

        const instanceName = args.prefix
          ? `prefix-${args.prefix.replace(/\//g, "-")}`
          : "all";

        const handle = await context.writeResource("log_groups", instanceName, {
          logGroups,
          count: logGroups.length,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} log groups", {
          count: logGroups.length,
        });
        return { dataHandles: [handle] };
      },
    },

    query: {
      description: "Run a CloudWatch Logs Insights query",
      arguments: z.object({
        logGroupNames: z
          .array(z.string())
          .describe("Log group names to query"),
        queryString: z
          .string()
          .describe(
            "Logs Insights query string (e.g., 'fields @timestamp, @message | filter @message like /error/i | limit 50')",
          ),
        startTime: z
          .string()
          .default("1h")
          .describe("Start time (ISO date or relative: 1h, 30m, 2d)"),
        endTime: z
          .string()
          .optional()
          .describe("End time (ISO date, defaults to now)"),
        maxWaitSeconds: z
          .number()
          .default(30)
          .describe("Maximum seconds to wait for query completion"),
      }),
      execute: async (
        args: {
          logGroupNames: string[];
          queryString: string;
          startTime: string;
          endTime?: string;
          maxWaitSeconds: number;
        },
        context: {
          globalArgs: { region: string };
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
        const client = new CloudWatchLogsClient({
          region: context.globalArgs.region,
        });

        const startTime = parseRelativeTime(args.startTime);
        const endTime = args.endTime
          ? parseRelativeTime(args.endTime)
          : new Date();

        // Start the query
        const startCommand = new StartQueryCommand({
          logGroupNames: args.logGroupNames,
          queryString: args.queryString,
          startTime: Math.floor(startTime.getTime() / 1000),
          endTime: Math.floor(endTime.getTime() / 1000),
        });

        const startResponse = await client.send(startCommand);
        const queryId = startResponse.queryId;

        if (!queryId) {
          throw new Error("Failed to start query - no queryId returned");
        }

        context.logger.info("Started query {queryId}", { queryId });

        // Wait for completion
        const { status, results, statistics } = await waitForQueryCompletion(
          client,
          queryId,
          args.maxWaitSeconds * 1000,
        );

        const instanceName = `query-${Date.now()}-${
          args.logGroupNames[0]?.replace(/\//g, "-") || "unknown"
        }`;

        const handle = await context.writeResource(
          "query_results",
          instanceName,
          {
            queryId,
            status,
            results,
            statistics,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Query {status}: {matched} records matched, {scanned} scanned",
          {
            status,
            matched: statistics?.recordsMatched || 0,
            scanned: statistics?.recordsScanned || 0,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    find_errors: {
      description:
        "Find and analyze error patterns in log groups using common error keywords",
      arguments: z.object({
        logGroupNames: z
          .array(z.string())
          .describe("Log group names to search"),
        startTime: z
          .string()
          .default("1h")
          .describe("Start time (ISO date or relative: 1h, 30m, 2d)"),
        endTime: z
          .string()
          .optional()
          .describe("End time (ISO date, defaults to now)"),
        keywords: z
          .array(z.string())
          .default(["error", "exception", "fail", "fatal", "timeout"])
          .describe("Error keywords to search for"),
        limit: z
          .number()
          .default(100)
          .describe("Maximum number of error events to analyze"),
      }),
      execute: async (
        args: {
          logGroupNames: string[];
          startTime: string;
          endTime?: string;
          keywords: string[];
          limit: number;
        },
        context: {
          globalArgs: { region: string };
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
        const client = new CloudWatchLogsClient({
          region: context.globalArgs.region,
        });

        const startTime = parseRelativeTime(args.startTime);
        const endTime = args.endTime
          ? parseRelativeTime(args.endTime)
          : new Date();

        // Query for error patterns
        const queryString = `
          fields @timestamp, @message, @logStream
          | filter @message like /(?i)(${args.keywords.join("|")})/
          | sort @timestamp desc
          | limit ${args.limit}
        `;

        const startCommand = new StartQueryCommand({
          logGroupNames: args.logGroupNames,
          queryString,
          startTime: Math.floor(startTime.getTime() / 1000),
          endTime: Math.floor(endTime.getTime() / 1000),
        });

        const startResponse = await client.send(startCommand);
        const queryId = startResponse.queryId;

        if (!queryId) {
          throw new Error("Failed to start error query");
        }

        const { results } = await waitForQueryCompletion(
          client,
          queryId,
          30000,
        );

        // Analyze patterns from results
        const patternCounts = new Map<
          string,
          {
            count: number;
            firstTs: string | null;
            lastTs: string | null;
            samples: string[];
          }
        >();

        for (const row of results) {
          const message = row["@message"] || "";
          const timestamp = row["@timestamp"] || "";

          // Extract a simplified pattern (remove timestamps, IDs, numbers)
          const pattern = message
            .replace(
              /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*/g,
              "[TIMESTAMP]",
            )
            .replace(
              /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
              "[UUID]",
            )
            .replace(/\b\d+\b/g, "[NUM]")
            .substring(0, 200);

          const existing = patternCounts.get(pattern);
          if (existing) {
            existing.count++;
            if (timestamp < (existing.firstTs || "")) {
              existing.firstTs = timestamp;
            }
            if (timestamp > (existing.lastTs || "")) {
              existing.lastTs = timestamp;
            }
            if (existing.samples.length < 3) {
              existing.samples.push(message.substring(0, 500));
            }
          } else {
            patternCounts.set(pattern, {
              count: 1,
              firstTs: timestamp,
              lastTs: timestamp,
              samples: [message.substring(0, 500)],
            });
          }
        }

        // Convert to sorted array
        const patterns = [...patternCounts.entries()]
          .map(([pattern, data]) => ({
            pattern,
            count: data.count,
            firstOccurrence: data.firstTs,
            lastOccurrence: data.lastTs,
            sampleMessages: data.samples,
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20);

        const instanceName = `errors-${
          args.logGroupNames[0]?.replace(/\//g, "-") || "unknown"
        }`;

        const handle = await context.writeResource(
          "error_analysis",
          instanceName,
          {
            logGroupName: args.logGroupNames.join(", "),
            timeRange: {
              start: startTime.toISOString(),
              end: endTime.toISOString(),
            },
            totalErrors: results.length,
            patterns,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Found {total} errors with {patterns} unique patterns",
          {
            total: results.length,
            patterns: patterns.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    get_recent_events: {
      description: "Get recent log events from a log group using filter",
      arguments: z.object({
        logGroupName: z.string().describe("Log group name"),
        filterPattern: z
          .string()
          .optional()
          .describe(
            "CloudWatch filter pattern (e.g., 'ERROR' or '{ $.level = \"error\" }')",
          ),
        startTime: z
          .string()
          .default("1h")
          .describe("Start time (ISO date or relative: 1h, 30m, 2d)"),
        limit: z
          .number()
          .default(100)
          .describe("Maximum number of events to return"),
      }),
      execute: async (
        args: {
          logGroupName: string;
          filterPattern?: string;
          startTime: string;
          limit: number;
        },
        context: {
          globalArgs: { region: string };
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
        const client = new CloudWatchLogsClient({
          region: context.globalArgs.region,
        });

        const startTime = parseRelativeTime(args.startTime);
        const events: z.infer<typeof LogEventSchema>[] = [];
        let nextToken: string | undefined;

        do {
          const command = new FilterLogEventsCommand({
            logGroupName: args.logGroupName,
            filterPattern: args.filterPattern,
            startTime: startTime.getTime(),
            limit: Math.min(100, args.limit - events.length),
            nextToken,
          });

          const response = await client.send(command);

          if (response.events) {
            for (const event of response.events) {
              if (events.length >= args.limit) break;
              events.push({
                timestamp: event.timestamp
                  ? new Date(event.timestamp).toISOString()
                  : "",
                message: event.message || "",
                logStreamName: event.logStreamName || null,
              });
            }
          }

          nextToken = response.nextToken;
        } while (nextToken && events.length < args.limit);

        const instanceName = `events-${args.logGroupName.replace(/\//g, "-")}`;

        const handle = await context.writeResource(
          "query_results",
          instanceName,
          {
            queryId: "filter-events",
            status: "Complete",
            results: events.map((e) => ({
              "@timestamp": e.timestamp,
              "@message": e.message,
              "@logStream": e.logStreamName || "",
            })),
            statistics: {
              recordsMatched: events.length,
              recordsScanned: events.length,
              bytesScanned: 0,
            },
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Retrieved {count} log events", {
          count: events.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
