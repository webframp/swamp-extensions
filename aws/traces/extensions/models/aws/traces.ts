/**
 * AWS X-Ray Traces Operations Model
 *
 * Provides methods to query and analyze AWS X-Ray distributed traces,
 * including service dependency graphs, trace summaries, error filtering,
 * and error-pattern analysis for incident investigation.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
import {
  GetServiceGraphCommand,
  GetTraceSummariesCommand,
  XRayClient,
} from "npm:@aws-sdk/client-xray@3.1010.0";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region for X-Ray"),
});

const ServiceNodeSchema = z.object({
  name: z.string(),
  type: z.string().nullable(),
  referenceId: z.number().nullable(),
  accountId: z.string().nullable(),
  state: z.string().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  edges: z.array(z.object({
    referenceId: z.number(),
    summaryStatistics: z.object({
      okCount: z.number(),
      errorStatistics: z.object({
        throttleCount: z.number(),
        otherCount: z.number(),
        totalCount: z.number(),
      }),
      faultStatistics: z.object({
        otherCount: z.number(),
        totalCount: z.number(),
      }),
      totalCount: z.number(),
      totalResponseTime: z.number(),
    }).nullable(),
  })),
  summaryStatistics: z.object({
    okCount: z.number(),
    errorStatistics: z.object({
      throttleCount: z.number(),
      otherCount: z.number(),
      totalCount: z.number(),
    }),
    faultStatistics: z.object({
      otherCount: z.number(),
      totalCount: z.number(),
    }),
    totalCount: z.number(),
    totalResponseTime: z.number(),
  }).nullable(),
  responseTimeHistogram: z.array(z.object({
    value: z.number(),
    count: z.number(),
  })),
});

const ServiceGraphSchema = z.object({
  services: z.array(ServiceNodeSchema),
  timeRange: z.object({
    start: z.string(),
    end: z.string(),
  }),
  containsOldGroupVersions: z.boolean(),
  fetchedAt: z.string(),
});

const TraceSummarySchema = z.object({
  traceId: z.string(),
  duration: z.number().nullable(),
  responseTime: z.number().nullable(),
  hasFault: z.boolean(),
  hasError: z.boolean(),
  hasThrottle: z.boolean(),
  isPartial: z.boolean(),
  http: z.object({
    httpURL: z.string().nullable(),
    httpMethod: z.string().nullable(),
    httpStatus: z.number().nullable(),
    userAgent: z.string().nullable(),
    clientIp: z.string().nullable(),
  }).nullable(),
  annotations: z.record(
    z.string(),
    z.array(z.object({
      annotationValue: z.string(),
    })),
  ),
  users: z.array(z.object({
    userName: z.string().nullable(),
  })),
  serviceIds: z.array(z.object({
    name: z.string().nullable(),
    type: z.string().nullable(),
    accountId: z.string().nullable(),
  })),
});

const TraceSummaryListSchema = z.object({
  traces: z.array(TraceSummarySchema),
  count: z.number(),
  filterExpression: z.string().nullable(),
  timeRange: z.object({
    start: z.string(),
    end: z.string(),
  }),
  fetchedAt: z.string(),
});

const ErrorAnalysisSchema = z.object({
  totalTraces: z.number(),
  faultCount: z.number(),
  errorCount: z.number(),
  throttleCount: z.number(),
  faultRate: z.number(),
  errorRate: z.number(),
  throttleRate: z.number(),
  topFaultyServices: z.array(z.object({
    serviceName: z.string(),
    faultCount: z.number(),
  })),
  topFaultyUrls: z.array(z.object({
    url: z.string(),
    faultCount: z.number(),
  })),
  timeRange: z.object({
    start: z.string(),
    end: z.string(),
  }),
  fetchedAt: z.string(),
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Parse a time string into a Date.
 *
 * Accepts relative durations such as 30m, 1h, or 2d (minutes, hours,
 * days before now) and ISO 8601 timestamps. Falls back to one hour ago when
 * the input cannot be parsed.
 */
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

  return new Date(now.getTime() - 60 * 60 * 1000);
}

/** Local interface representing X-Ray edge summary statistics. */
interface EdgeStatistics {
  OkCount?: number;
  ErrorStatistics?: {
    ThrottleCount?: number;
    OtherCount?: number;
    TotalCount?: number;
  };
  FaultStatistics?: {
    OtherCount?: number;
    TotalCount?: number;
  };
  TotalCount?: number;
  TotalResponseTime?: number;
}

/** Local interface for a service-to-service edge in the X-Ray graph. */
interface ServiceEdge {
  ReferenceId?: number;
  SummaryStatistics?: EdgeStatistics;
}

/** Local interface for a response-time histogram bucket. */
interface HistogramEntry {
  Value?: number;
  Count?: number;
}

/** Local interface representing an X-Ray service node. */
interface ServiceNode {
  Name?: string;
  Type?: string;
  ReferenceId?: number;
  AccountId?: string;
  State?: string;
  StartTime?: Date;
  EndTime?: Date;
  Edges?: ServiceEdge[];
  SummaryStatistics?: EdgeStatistics;
  ResponseTimeHistogram?: HistogramEntry[];
}

/** Local interface for an X-Ray trace annotation value. */
interface AnnotationValue {
  AnnotationValue?: {
    StringValue?: string;
    NumberValue?: number;
    BooleanValue?: boolean;
  };
}

/** Local interface for an X-Ray trace user identity. */
interface TraceUser {
  UserName?: string;
}

/** Local interface for an X-Ray service identifier. */
interface ServiceId {
  Name?: string;
  Type?: string;
  AccountId?: string;
}

/** Local interface for HTTP metadata on a trace. */
interface HttpInfo {
  HttpURL?: string;
  HttpMethod?: string;
  HttpStatus?: number;
  UserAgent?: string;
  ClientIp?: string;
}

/** Local interface for a raw X-Ray trace summary. */
interface TraceSummaryItem {
  Id?: string;
  Duration?: number;
  ResponseTime?: number;
  HasFault?: boolean;
  HasError?: boolean;
  HasThrottle?: boolean;
  IsPartial?: boolean;
  Http?: HttpInfo;
  Annotations?: Record<string, AnnotationValue[]>;
  Users?: TraceUser[];
  ServiceIds?: ServiceId[];
}

// =============================================================================
// Model Definition
// =============================================================================

/**
 * X-Ray traces model definition.
 *
 * Exposes four methods -- get_service_graph, get_traces, get_errors,
 * and analyze_errors -- that query the AWS X-Ray API and write structured
 * resources for downstream consumption by swamp reports and workflows.
 */
export const model = {
  type: "@webframp/aws/traces",
  version: "2026.03.30.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    service_graph: {
      description: "X-Ray service dependency graph",
      schema: ServiceGraphSchema,
      lifetime: "30m" as const,
      garbageCollection: 5,
    },
    trace_summaries: {
      description: "List of trace summaries",
      schema: TraceSummaryListSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    error_analysis: {
      description: "Analysis of errors and faults in traces",
      schema: ErrorAnalysisSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    get_service_graph: {
      description:
        "Get the X-Ray service dependency graph showing service relationships and health",
      arguments: z.object({
        startTime: z
          .string()
          .default("1h")
          .describe("Start time (ISO date or relative: 1h, 30m, 2d)"),
        endTime: z
          .string()
          .optional()
          .describe("End time (ISO date, defaults to now)"),
        groupName: z
          .string()
          .optional()
          .describe("X-Ray group name to filter by"),
      }),
      execute: async (
        args: { startTime: string; endTime?: string; groupName?: string },
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
        const client = new XRayClient({
          region: context.globalArgs.region,
        });

        const startTime = parseRelativeTime(args.startTime);
        const endTime = args.endTime
          ? parseRelativeTime(args.endTime)
          : new Date();

        const services: z.infer<typeof ServiceNodeSchema>[] = [];
        let nextToken: string | undefined;
        let containsOldVersions = false;

        do {
          const command = new GetServiceGraphCommand({
            StartTime: startTime,
            EndTime: endTime,
            GroupName: args.groupName,
            NextToken: nextToken,
          });
          const response = await client.send(command);

          if (response.ContainsOldGroupVersions) {
            containsOldVersions = true;
          }

          if (response.Services) {
            for (const svc of response.Services) {
              services.push(mapService(svc as ServiceNode));
            }
          }

          nextToken = response.NextToken;
        } while (nextToken);

        const instanceName = args.groupName
          ? `graph-${args.groupName.replace(/[\/\s]/g, "-")}`
          : "graph-default";

        const handle = await context.writeResource(
          "service_graph",
          instanceName,
          {
            services,
            timeRange: {
              start: startTime.toISOString(),
              end: endTime.toISOString(),
            },
            containsOldGroupVersions: containsOldVersions,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} services in graph", {
          count: services.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_traces: {
      description: "Get trace summaries with optional filter expression",
      arguments: z.object({
        startTime: z
          .string()
          .default("1h")
          .describe("Start time (ISO date or relative: 1h, 30m, 2d)"),
        endTime: z
          .string()
          .optional()
          .describe("End time (ISO date, defaults to now)"),
        filterExpression: z
          .string()
          .optional()
          .describe(
            "X-Ray filter expression (e.g., 'service(\"api\") AND http.status = 500')",
          ),
        sampling: z
          .boolean()
          .default(true)
          .describe("Enable sampling for large result sets"),
        limit: z
          .number()
          .default(100)
          .describe("Maximum number of traces to return"),
      }),
      execute: async (
        args: {
          startTime: string;
          endTime?: string;
          filterExpression?: string;
          sampling: boolean;
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
        const client = new XRayClient({
          region: context.globalArgs.region,
        });

        const startTime = parseRelativeTime(args.startTime);
        const endTime = args.endTime
          ? parseRelativeTime(args.endTime)
          : new Date();

        const traces: z.infer<typeof TraceSummarySchema>[] = [];
        let nextToken: string | undefined;

        do {
          const command = new GetTraceSummariesCommand({
            StartTime: startTime,
            EndTime: endTime,
            FilterExpression: args.filterExpression,
            Sampling: args.sampling,
            NextToken: nextToken,
          });
          const response = await client.send(command);

          if (response.TraceSummaries) {
            for (const trace of response.TraceSummaries) {
              if (traces.length >= args.limit) break;
              traces.push(mapTraceSummary(trace as TraceSummaryItem));
            }
          }

          nextToken = response.NextToken;
        } while (nextToken && traces.length < args.limit);

        const instanceName = args.filterExpression
          ? `traces-filtered-${Date.now()}`
          : `traces-${Date.now()}`;

        const handle = await context.writeResource(
          "trace_summaries",
          instanceName,
          {
            traces,
            count: traces.length,
            filterExpression: args.filterExpression || null,
            timeRange: {
              start: startTime.toISOString(),
              end: endTime.toISOString(),
            },
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} traces", { count: traces.length });
        return { dataHandles: [handle] };
      },
    },

    get_errors: {
      description:
        "Get traces with errors or faults (convenience method for incident investigation)",
      arguments: z.object({
        startTime: z
          .string()
          .default("1h")
          .describe("Start time (ISO date or relative: 1h, 30m, 2d)"),
        endTime: z
          .string()
          .optional()
          .describe("End time (ISO date, defaults to now)"),
        errorType: z
          .enum(["fault", "error", "throttle", "any"])
          .default("any")
          .describe("Type of error to filter for"),
        limit: z
          .number()
          .default(50)
          .describe("Maximum number of traces to return"),
      }),
      execute: async (
        args: {
          startTime: string;
          endTime?: string;
          errorType: "fault" | "error" | "throttle" | "any";
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
        const client = new XRayClient({
          region: context.globalArgs.region,
        });

        const startTime = parseRelativeTime(args.startTime);
        const endTime = args.endTime
          ? parseRelativeTime(args.endTime)
          : new Date();

        // Build filter expression based on error type
        let filterExpression: string;
        switch (args.errorType) {
          case "fault":
            filterExpression = "fault = true";
            break;
          case "error":
            filterExpression = "error = true";
            break;
          case "throttle":
            filterExpression = "throttle = true";
            break;
          case "any":
          default:
            filterExpression =
              "fault = true OR error = true OR throttle = true";
        }

        const traces: z.infer<typeof TraceSummarySchema>[] = [];
        let nextToken: string | undefined;

        do {
          const command = new GetTraceSummariesCommand({
            StartTime: startTime,
            EndTime: endTime,
            FilterExpression: filterExpression,
            Sampling: false, // Don't sample for error investigation
            NextToken: nextToken,
          });
          const response = await client.send(command);

          if (response.TraceSummaries) {
            for (const trace of response.TraceSummaries) {
              if (traces.length >= args.limit) break;
              traces.push(mapTraceSummary(trace as TraceSummaryItem));
            }
          }

          nextToken = response.NextToken;
        } while (nextToken && traces.length < args.limit);

        const instanceName = `errors-${args.errorType}-${Date.now()}`;

        const handle = await context.writeResource(
          "trace_summaries",
          instanceName,
          {
            traces,
            count: traces.length,
            filterExpression,
            timeRange: {
              start: startTime.toISOString(),
              end: endTime.toISOString(),
            },
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} error traces", {
          count: traces.length,
        });
        return { dataHandles: [handle] };
      },
    },

    analyze_errors: {
      description:
        "Analyze error patterns across traces for incident investigation",
      arguments: z.object({
        startTime: z
          .string()
          .default("1h")
          .describe("Start time (ISO date or relative: 1h, 30m, 2d)"),
        endTime: z
          .string()
          .optional()
          .describe("End time (ISO date, defaults to now)"),
      }),
      execute: async (
        args: { startTime: string; endTime?: string },
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
        const client = new XRayClient({
          region: context.globalArgs.region,
        });

        const startTime = parseRelativeTime(args.startTime);
        const endTime = args.endTime
          ? parseRelativeTime(args.endTime)
          : new Date();

        // Get all traces for analysis
        const allTraces: TraceSummaryItem[] = [];
        let nextToken: string | undefined;

        do {
          const command = new GetTraceSummariesCommand({
            StartTime: startTime,
            EndTime: endTime,
            Sampling: true,
            NextToken: nextToken,
          });
          const response = await client.send(command);

          if (response.TraceSummaries) {
            allTraces.push(...(response.TraceSummaries as TraceSummaryItem[]));
          }

          nextToken = response.NextToken;
          // Limit to 1000 traces for analysis
        } while (nextToken && allTraces.length < 1000);

        // Analyze the traces
        let faultCount = 0;
        let errorCount = 0;
        let throttleCount = 0;
        const serviceFaults: Record<string, number> = {};
        const urlFaults: Record<string, number> = {};

        for (const trace of allTraces) {
          if (trace.HasFault) faultCount++;
          if (trace.HasError) errorCount++;
          if (trace.HasThrottle) throttleCount++;

          if (trace.HasFault) {
            // Track faulty services
            if (trace.ServiceIds) {
              for (const svc of trace.ServiceIds) {
                const name = svc.Name || "unknown";
                serviceFaults[name] = (serviceFaults[name] || 0) + 1;
              }
            }

            // Track faulty URLs
            if (trace.Http?.HttpURL) {
              const url = trace.Http.HttpURL;
              urlFaults[url] = (urlFaults[url] || 0) + 1;
            }
          }
        }

        const totalTraces = allTraces.length;
        const faultRate = totalTraces > 0 ? faultCount / totalTraces : 0;
        const errorRate = totalTraces > 0 ? errorCount / totalTraces : 0;
        const throttleRate = totalTraces > 0 ? throttleCount / totalTraces : 0;

        // Sort and get top faulty services
        const topFaultyServices = Object.entries(serviceFaults)
          .map(([serviceName, count]) => ({ serviceName, faultCount: count }))
          .sort((a, b) => b.faultCount - a.faultCount)
          .slice(0, 10);

        // Sort and get top faulty URLs
        const topFaultyUrls = Object.entries(urlFaults)
          .map(([url, count]) => ({ url, faultCount: count }))
          .sort((a, b) => b.faultCount - a.faultCount)
          .slice(0, 10);

        const handle = await context.writeResource(
          "error_analysis",
          `analysis-${Date.now()}`,
          {
            totalTraces,
            faultCount,
            errorCount,
            throttleCount,
            faultRate,
            errorRate,
            throttleRate,
            topFaultyServices,
            topFaultyUrls,
            timeRange: {
              start: startTime.toISOString(),
              end: endTime.toISOString(),
            },
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Analyzed {total} traces: {faults} faults ({rate}%)",
          {
            total: totalTraces,
            faults: faultCount,
            rate: (faultRate * 100).toFixed(1),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

// =============================================================================
// Helper Functions for Mapping
// =============================================================================

/** Map raw X-Ray edge statistics to the normalized schema shape. */
function mapStatistics(stats: EdgeStatistics | undefined): {
  okCount: number;
  errorStatistics: {
    throttleCount: number;
    otherCount: number;
    totalCount: number;
  };
  faultStatistics: {
    otherCount: number;
    totalCount: number;
  };
  totalCount: number;
  totalResponseTime: number;
} | null {
  if (!stats) return null;
  return {
    okCount: stats.OkCount ?? 0,
    errorStatistics: {
      throttleCount: stats.ErrorStatistics?.ThrottleCount ?? 0,
      otherCount: stats.ErrorStatistics?.OtherCount ?? 0,
      totalCount: stats.ErrorStatistics?.TotalCount ?? 0,
    },
    faultStatistics: {
      otherCount: stats.FaultStatistics?.OtherCount ?? 0,
      totalCount: stats.FaultStatistics?.TotalCount ?? 0,
    },
    totalCount: stats.TotalCount ?? 0,
    totalResponseTime: stats.TotalResponseTime ?? 0,
  };
}

/** Map a raw X-Ray service node to the ServiceNodeSchema shape. */
function mapService(svc: ServiceNode): z.infer<typeof ServiceNodeSchema> {
  return {
    name: svc.Name || "",
    type: svc.Type || null,
    referenceId: svc.ReferenceId ?? null,
    accountId: svc.AccountId || null,
    state: svc.State || null,
    startTime: svc.StartTime?.toISOString() || null,
    endTime: svc.EndTime?.toISOString() || null,
    edges: (svc.Edges || []).map((edge: ServiceEdge) => ({
      referenceId: edge.ReferenceId ?? 0,
      summaryStatistics: mapStatistics(edge.SummaryStatistics),
    })),
    summaryStatistics: mapStatistics(svc.SummaryStatistics),
    responseTimeHistogram: (svc.ResponseTimeHistogram || []).map(
      (h: HistogramEntry) => ({
        value: h.Value ?? 0,
        count: h.Count ?? 0,
      }),
    ),
  };
}

/** Map a raw X-Ray trace summary to the TraceSummarySchema shape. */
function mapTraceSummary(
  trace: TraceSummaryItem,
): z.infer<typeof TraceSummarySchema> {
  return {
    traceId: trace.Id || "",
    duration: trace.Duration ?? null,
    responseTime: trace.ResponseTime ?? null,
    hasFault: trace.HasFault ?? false,
    hasError: trace.HasError ?? false,
    hasThrottle: trace.HasThrottle ?? false,
    isPartial: trace.IsPartial ?? false,
    http: trace.Http
      ? {
        httpURL: trace.Http.HttpURL || null,
        httpMethod: trace.Http.HttpMethod || null,
        httpStatus: trace.Http.HttpStatus ?? null,
        userAgent: trace.Http.UserAgent || null,
        clientIp: trace.Http.ClientIp || null,
      }
      : null,
    annotations: Object.fromEntries(
      Object.entries(trace.Annotations || {}).map(([key, values]) => [
        key,
        (values as AnnotationValue[]).map((v: AnnotationValue) => ({
          annotationValue: String(
            v.AnnotationValue?.StringValue ??
              v.AnnotationValue?.NumberValue ??
              v.AnnotationValue?.BooleanValue ??
              "",
          ),
        })),
      ]),
    ),
    users: (trace.Users || []).map((u: TraceUser) => ({
      userName: u.UserName || null,
    })),
    serviceIds: (trace.ServiceIds || []).map((s: ServiceId) => ({
      name: s.Name || null,
      type: s.Type || null,
      accountId: s.AccountId || null,
    })),
  };
}
