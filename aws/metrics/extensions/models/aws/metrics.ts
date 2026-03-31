// AWS CloudWatch Metrics Operations Model
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  GetMetricStatisticsCommand,
  ListMetricsCommand,
} from "npm:@aws-sdk/client-cloudwatch@3.1010.0";

// Local types for SDK responses
interface AwsDimension {
  Name?: string;
  Value?: string;
}

interface AwsDatapoint {
  Timestamp?: Date;
  Average?: number;
  Sum?: number;
  Minimum?: number;
  Maximum?: number;
  SampleCount?: number;
  Unit?: string;
  [key: string]: unknown;
}

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region for CloudWatch Metrics"),
});

const DimensionSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const MetricSchema = z.object({
  namespace: z.string(),
  metricName: z.string(),
  dimensions: z.array(DimensionSchema),
});

const MetricListSchema = z.object({
  namespace: z.string().nullable(),
  metrics: z.array(MetricSchema),
  count: z.number(),
  fetchedAt: z.string(),
});

const DatapointSchema = z.object({
  timestamp: z.string(),
  value: z.number(),
  unit: z.string().nullable(),
});

const MetricDataSchema = z.object({
  metric: MetricSchema,
  statistic: z.string(),
  period: z.number(),
  datapoints: z.array(DatapointSchema),
  timeRange: z.object({
    start: z.string(),
    end: z.string(),
  }),
  fetchedAt: z.string(),
});

const MetricAnalysisSchema = z.object({
  metric: MetricSchema,
  statistic: z.string(),
  timeRange: z.object({
    start: z.string(),
    end: z.string(),
  }),
  summary: z.object({
    min: z.number(),
    max: z.number(),
    avg: z.number(),
    sum: z.number(),
    count: z.number(),
  }),
  trend: z.enum(["increasing", "decreasing", "stable", "insufficient_data"]),
  anomalies: z.array(z.object({
    timestamp: z.string(),
    value: z.number(),
    deviation: z.number(),
  })),
  fetchedAt: z.string(),
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

  return new Date(now.getTime() - 60 * 60 * 1000);
}

function calculatePeriod(startTime: Date, endTime: Date): number {
  const durationMs = endTime.getTime() - startTime.getTime();
  const durationHours = durationMs / (1000 * 60 * 60);

  // Target ~60 data points
  if (durationHours <= 1) return 60; // 1 minute
  if (durationHours <= 6) return 300; // 5 minutes
  if (durationHours <= 24) return 900; // 15 minutes
  if (durationHours <= 72) return 3600; // 1 hour
  return 86400; // 1 day
}

function calculateTrend(
  datapoints: Array<{ timestamp: string; value: number }>,
): "increasing" | "decreasing" | "stable" | "insufficient_data" {
  if (datapoints.length < 3) return "insufficient_data";

  // Simple linear regression
  const n = datapoints.length;
  const sorted = [...datapoints].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += sorted[i].value;
    sumXY += i * sorted[i].value;
    sumX2 += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const avgValue = sumY / n;

  // Normalize slope relative to average value
  const normalizedSlope = avgValue !== 0 ? slope / avgValue : 0;

  if (Math.abs(normalizedSlope) < 0.01) return "stable";
  return normalizedSlope > 0 ? "increasing" : "decreasing";
}

function findAnomalies(
  datapoints: Array<{ timestamp: string; value: number }>,
  threshold: number = 2,
): Array<{ timestamp: string; value: number; deviation: number }> {
  if (datapoints.length < 5) return [];

  const values = datapoints.map((d) => d.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) /
    values.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return [];

  return datapoints
    .map((d) => ({
      timestamp: d.timestamp,
      value: d.value,
      deviation: Math.abs(d.value - mean) / stdDev,
    }))
    .filter((d) => d.deviation > threshold)
    .sort((a, b) => b.deviation - a.deviation)
    .slice(0, 10);
}

// =============================================================================
// Model Definition
// =============================================================================

export const model = {
  type: "@webframp/aws/metrics",
  version: "2026.03.30.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    metric_list: {
      description: "List of CloudWatch metrics",
      schema: MetricListSchema,
      lifetime: "1h" as const,
      garbageCollection: 5,
    },
    metric_data: {
      description: "CloudWatch metric data points",
      schema: MetricDataSchema,
      lifetime: "1h" as const,
      garbageCollection: 20,
    },
    metric_analysis: {
      description: "Metric analysis with trend and anomalies",
      schema: MetricAnalysisSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    list_metrics: {
      description: "List available CloudWatch metrics by namespace",
      arguments: z.object({
        namespace: z
          .string()
          .optional()
          .describe("AWS namespace (e.g., AWS/EC2, AWS/Lambda)"),
        metricName: z
          .string()
          .optional()
          .describe("Filter by metric name"),
        limit: z
          .number()
          .default(100)
          .describe("Maximum number of metrics to return"),
      }),
      execute: async (
        args: { namespace?: string; metricName?: string; limit: number },
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
        const client = new CloudWatchClient({
          region: context.globalArgs.region,
        });
        const metrics: z.infer<typeof MetricSchema>[] = [];
        let nextToken: string | undefined;

        do {
          const command = new ListMetricsCommand({
            Namespace: args.namespace,
            MetricName: args.metricName,
            NextToken: nextToken,
          });
          const response = await client.send(command);

          if (response.Metrics) {
            for (const m of response.Metrics) {
              if (metrics.length >= args.limit) break;
              metrics.push({
                namespace: m.Namespace || "",
                metricName: m.MetricName || "",
                dimensions: (m.Dimensions || []).map((d: AwsDimension) => ({
                  name: d.Name || "",
                  value: d.Value || "",
                })),
              });
            }
          }

          nextToken = response.NextToken;
        } while (nextToken && metrics.length < args.limit);

        const instanceName = args.namespace
          ? `ns-${args.namespace.replace(/\//g, "-")}`
          : "all";

        const handle = await context.writeResource(
          "metric_list",
          instanceName,
          {
            namespace: args.namespace || null,
            metrics,
            count: metrics.length,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} metrics", { count: metrics.length });
        return { dataHandles: [handle] };
      },
    },

    get_data: {
      description: "Get metric data points for a specific metric",
      arguments: z.object({
        namespace: z.string().describe("AWS namespace (e.g., AWS/EC2)"),
        metricName: z.string().describe("Metric name (e.g., CPUUtilization)"),
        dimensions: z
          .array(
            z.object({
              name: z.string(),
              value: z.string(),
            }),
          )
          .default([])
          .describe("Metric dimensions"),
        statistic: z
          .enum(["Average", "Sum", "Minimum", "Maximum", "SampleCount"])
          .default("Average")
          .describe("Statistic to retrieve"),
        startTime: z
          .string()
          .default("1h")
          .describe("Start time (ISO date or relative: 1h, 30m, 2d)"),
        endTime: z
          .string()
          .optional()
          .describe("End time (ISO date, defaults to now)"),
        period: z
          .number()
          .optional()
          .describe("Period in seconds (auto-calculated if not specified)"),
      }),
      execute: async (
        args: {
          namespace: string;
          metricName: string;
          dimensions: Array<{ name: string; value: string }>;
          statistic: "Average" | "Sum" | "Minimum" | "Maximum" | "SampleCount";
          startTime: string;
          endTime?: string;
          period?: number;
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
        const client = new CloudWatchClient({
          region: context.globalArgs.region,
        });

        const startTime = parseRelativeTime(args.startTime);
        const endTime = args.endTime
          ? parseRelativeTime(args.endTime)
          : new Date();
        const period = args.period || calculatePeriod(startTime, endTime);

        const dimensions: AwsDimension[] = args.dimensions.map((d) => ({
          Name: d.name,
          Value: d.value,
        }));

        const command = new GetMetricStatisticsCommand({
          Namespace: args.namespace,
          MetricName: args.metricName,
          Dimensions: dimensions.length > 0 ? dimensions : undefined,
          StartTime: startTime,
          EndTime: endTime,
          Period: period,
          Statistics: [args.statistic],
        });

        const response = await client.send(command);

        const datapoints = (response.Datapoints || [])
          .map((dp: AwsDatapoint) => ({
            timestamp: dp.Timestamp?.toISOString() || "",
            value: (dp[args.statistic] as number) ?? 0,
            unit: dp.Unit || null,
          }))
          .sort(
            (a: { timestamp: string }, b: { timestamp: string }) =>
              new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          );

        const dimStr = args.dimensions
          .map((d) => `${d.name}=${d.value}`)
          .join(",");
        const instanceName = `${args.namespace}-${args.metricName}-${
          dimStr || "all"
        }`.replace(
          /[\/\s]/g,
          "-",
        ).substring(0, 100);

        const handle = await context.writeResource(
          "metric_data",
          instanceName,
          {
            metric: {
              namespace: args.namespace,
              metricName: args.metricName,
              dimensions: args.dimensions,
            },
            statistic: args.statistic,
            period,
            datapoints,
            timeRange: {
              start: startTime.toISOString(),
              end: endTime.toISOString(),
            },
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Retrieved {count} datapoints for {metric}", {
          count: datapoints.length,
          metric: args.metricName,
        });
        return { dataHandles: [handle] };
      },
    },

    analyze: {
      description:
        "Analyze a metric for trends, anomalies, and summary statistics",
      arguments: z.object({
        namespace: z.string().describe("AWS namespace (e.g., AWS/EC2)"),
        metricName: z.string().describe("Metric name (e.g., CPUUtilization)"),
        dimensions: z
          .array(
            z.object({
              name: z.string(),
              value: z.string(),
            }),
          )
          .default([])
          .describe("Metric dimensions"),
        statistic: z
          .enum(["Average", "Sum", "Minimum", "Maximum", "SampleCount"])
          .default("Average")
          .describe("Statistic to analyze"),
        startTime: z
          .string()
          .default("6h")
          .describe("Start time (ISO date or relative: 1h, 30m, 2d)"),
        endTime: z
          .string()
          .optional()
          .describe("End time (ISO date, defaults to now)"),
        anomalyThreshold: z
          .number()
          .default(2)
          .describe("Standard deviations for anomaly detection"),
      }),
      execute: async (
        args: {
          namespace: string;
          metricName: string;
          dimensions: Array<{ name: string; value: string }>;
          statistic: "Average" | "Sum" | "Minimum" | "Maximum" | "SampleCount";
          startTime: string;
          endTime?: string;
          anomalyThreshold: number;
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
        const client = new CloudWatchClient({
          region: context.globalArgs.region,
        });

        const startTime = parseRelativeTime(args.startTime);
        const endTime = args.endTime
          ? parseRelativeTime(args.endTime)
          : new Date();
        const period = calculatePeriod(startTime, endTime);

        const dimensions: AwsDimension[] = args.dimensions.map((d) => ({
          Name: d.name,
          Value: d.value,
        }));

        const command = new GetMetricStatisticsCommand({
          Namespace: args.namespace,
          MetricName: args.metricName,
          Dimensions: dimensions.length > 0 ? dimensions : undefined,
          StartTime: startTime,
          EndTime: endTime,
          Period: period,
          Statistics: [args.statistic],
        });

        const response = await client.send(command);

        const datapoints = (response.Datapoints || [])
          .map((dp: AwsDatapoint) => ({
            timestamp: dp.Timestamp?.toISOString() || "",
            value: (dp[args.statistic] as number) ?? 0,
          }))
          .sort(
            (a: { timestamp: string }, b: { timestamp: string }) =>
              new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          );

        // Calculate summary statistics
        const values = datapoints.map((d: { value: number }) => d.value);
        const summary = values.length > 0
          ? {
            min: Math.min(...values),
            max: Math.max(...values),
            avg: values.reduce((a: number, b: number) => a + b, 0) /
              values.length,
            sum: values.reduce((a: number, b: number) => a + b, 0),
            count: values.length,
          }
          : { min: 0, max: 0, avg: 0, sum: 0, count: 0 };

        // Calculate trend
        const trend = calculateTrend(datapoints);

        // Find anomalies
        const anomalies = findAnomalies(datapoints, args.anomalyThreshold);

        const dimStr = args.dimensions
          .map((d) => `${d.name}=${d.value}`)
          .join(",");
        const instanceName = `analysis-${args.namespace}-${args.metricName}-${
          dimStr || "all"
        }`
          .replace(/[\/\s]/g, "-")
          .substring(0, 100);

        const handle = await context.writeResource(
          "metric_analysis",
          instanceName,
          {
            metric: {
              namespace: args.namespace,
              metricName: args.metricName,
              dimensions: args.dimensions,
            },
            statistic: args.statistic,
            timeRange: {
              start: startTime.toISOString(),
              end: endTime.toISOString(),
            },
            summary,
            trend,
            anomalies,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Analysis complete: trend={trend}, anomalies={anomalyCount}",
          {
            trend,
            anomalyCount: anomalies.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    get_ec2_cpu: {
      description: "Convenience method to get EC2 CPU utilization",
      arguments: z.object({
        instanceId: z.string().describe("EC2 instance ID"),
        startTime: z
          .string()
          .default("1h")
          .describe("Start time (ISO date or relative: 1h, 30m, 2d)"),
      }),
      execute: async (
        args: { instanceId: string; startTime: string },
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
        const client = new CloudWatchClient({
          region: context.globalArgs.region,
        });

        const startTime = parseRelativeTime(args.startTime);
        const endTime = new Date();
        const period = calculatePeriod(startTime, endTime);

        const command = new GetMetricStatisticsCommand({
          Namespace: "AWS/EC2",
          MetricName: "CPUUtilization",
          Dimensions: [{ Name: "InstanceId", Value: args.instanceId }],
          StartTime: startTime,
          EndTime: endTime,
          Period: period,
          Statistics: ["Average", "Maximum"],
        });

        const response = await client.send(command);

        const datapoints = (response.Datapoints || [])
          .map((dp: AwsDatapoint) => ({
            timestamp: dp.Timestamp?.toISOString() || "",
            average: dp.Average ?? 0,
            maximum: dp.Maximum ?? 0,
            unit: dp.Unit || "Percent",
          }))
          .sort(
            (a: { timestamp: string }, b: { timestamp: string }) =>
              new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          );

        const instanceName = `ec2-cpu-${args.instanceId}`;

        const handle = await context.writeResource(
          "metric_data",
          instanceName,
          {
            metric: {
              namespace: "AWS/EC2",
              metricName: "CPUUtilization",
              dimensions: [{ name: "InstanceId", value: args.instanceId }],
            },
            statistic: "Average",
            period,
            datapoints: datapoints.map((
              d: { timestamp: string; average: number; unit: string },
            ) => ({
              timestamp: d.timestamp,
              value: d.average,
              unit: d.unit,
            })),
            timeRange: {
              start: startTime.toISOString(),
              end: endTime.toISOString(),
            },
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info("Retrieved CPU data for {instanceId}", {
          instanceId: args.instanceId,
        });
        return { dataHandles: [handle] };
      },
    },

    get_lambda_metrics: {
      description:
        "Get key Lambda function metrics (invocations, errors, duration)",
      arguments: z.object({
        functionName: z.string().describe("Lambda function name"),
        startTime: z
          .string()
          .default("1h")
          .describe("Start time (ISO date or relative: 1h, 30m, 2d)"),
      }),
      execute: async (
        args: { functionName: string; startTime: string },
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
        const client = new CloudWatchClient({
          region: context.globalArgs.region,
        });

        const startTime = parseRelativeTime(args.startTime);
        const endTime = new Date();
        const period = calculatePeriod(startTime, endTime);

        const metricQueries = [
          {
            Id: "invocations",
            MetricStat: {
              Metric: {
                Namespace: "AWS/Lambda",
                MetricName: "Invocations",
                Dimensions: [{
                  Name: "FunctionName",
                  Value: args.functionName,
                }],
              },
              Period: period,
              Stat: "Sum",
            },
          },
          {
            Id: "errors",
            MetricStat: {
              Metric: {
                Namespace: "AWS/Lambda",
                MetricName: "Errors",
                Dimensions: [{
                  Name: "FunctionName",
                  Value: args.functionName,
                }],
              },
              Period: period,
              Stat: "Sum",
            },
          },
          {
            Id: "duration",
            MetricStat: {
              Metric: {
                Namespace: "AWS/Lambda",
                MetricName: "Duration",
                Dimensions: [{
                  Name: "FunctionName",
                  Value: args.functionName,
                }],
              },
              Period: period,
              Stat: "Average",
            },
          },
          {
            Id: "throttles",
            MetricStat: {
              Metric: {
                Namespace: "AWS/Lambda",
                MetricName: "Throttles",
                Dimensions: [{
                  Name: "FunctionName",
                  Value: args.functionName,
                }],
              },
              Period: period,
              Stat: "Sum",
            },
          },
        ];

        const command = new GetMetricDataCommand({
          MetricDataQueries: metricQueries,
          StartTime: startTime,
          EndTime: endTime,
        });

        const response = await client.send(command);

        const results: Record<
          string,
          Array<{ timestamp: string; value: number }>
        > = {};

        for (const result of response.MetricDataResults || []) {
          const id = result.Id || "unknown";
          const timestamps = result.Timestamps || [];
          const values = result.Values || [];

          results[id] = timestamps.map((ts: Date, i: number) => ({
            timestamp: ts.toISOString(),
            value: values[i] || 0,
          }));
        }

        const instanceName = `lambda-${
          args.functionName.replace(/[\/\s]/g, "-")
        }`;

        const handle = await context.writeResource(
          "metric_data",
          instanceName,
          {
            metric: {
              namespace: "AWS/Lambda",
              metricName: "multiple",
              dimensions: [{ name: "FunctionName", value: args.functionName }],
            },
            statistic: "multiple",
            period,
            datapoints: [], // Using custom structure
            timeRange: {
              start: startTime.toISOString(),
              end: endTime.toISOString(),
            },
            fetchedAt: new Date().toISOString(),
            // @ts-ignore - extending schema for Lambda-specific data
            lambdaMetrics: results,
          },
        );

        context.logger.info("Retrieved Lambda metrics for {functionName}", {
          functionName: args.functionName,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
