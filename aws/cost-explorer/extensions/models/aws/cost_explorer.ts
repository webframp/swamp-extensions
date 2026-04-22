/**
 * AWS Cost Explorer model for swamp.
 *
 * Queries AWS Cost Explorer to analyze actual cloud spend by service, usage
 * type, and time period. Provides methods to identify top cost drivers, track
 * daily spend trends, and compare costs between periods.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.3.6";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "npm:@aws-sdk/client-cost-explorer@3.1010.0";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region for the Cost Explorer endpoint"),
});

const CostByServiceSchema = z.object({
  service: z.string(),
  amount: z.number(),
  unit: z.string(),
  percentage: z.number(),
});

const CostByUsageTypeSchema = z.object({
  usageType: z.string(),
  amount: z.number(),
  unit: z.string(),
});

const CostTrendDataPointSchema = z.object({
  date: z.string(),
  amount: z.number(),
});

const CostTrendSchema = z.object({
  dataPoints: z.array(CostTrendDataPointSchema),
  trend: z.string(),
});

const CostDriverSchema = z.object({
  service: z.string(),
  usageType: z.string(),
  amount: z.number(),
  unit: z.string(),
});

const CostResultSchema = z.object({
  region: z.string(),
  queryType: z.string(),
  data: z.unknown(),
  fetchedAt: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

/** Build a date range ending today and spanning the given number of days. */
function formatPeriod(days: number): { Start: string; End: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  const fmt = (d: Date): string => d.toISOString().slice(0, 10);
  return { Start: fmt(start), End: fmt(end) };
}

// =============================================================================
// Context type (inline, matching existing pattern)
// =============================================================================

/** Execution context provided by swamp to each model method. */
type MethodContext = {
  globalArgs: { region: string };
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Model Definition
// =============================================================================

/**
 * AWS Cost Explorer model definition.
 *
 * Exposes five methods for querying AWS Cost Explorer:
 * - `get_cost_by_service` -- breakdown by AWS service
 * - `get_cost_by_usage_type` -- drill into a service's usage types
 * - `get_cost_trend` -- daily trend with direction detection
 * - `get_top_cost_drivers` -- top service/usage-type combinations
 * - `get_cost_comparison` -- period-over-period comparison
 */
export const model = {
  type: "@webframp/aws/cost-explorer",
  version: "2026.04.12.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    costs: {
      description: "AWS Cost Explorer query results",
      schema: CostResultSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    get_cost_by_service: {
      description:
        "Break down spend by AWS service for the given number of days",
      arguments: z.object({
        days: z
          .number()
          .default(30)
          .describe("Number of days to look back"),
      }),
      execute: async (
        args: { days: number },
        context: MethodContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const client = new CostExplorerClient({
          region: context.globalArgs.region,
        });
        const period = formatPeriod(args.days);

        const command = new GetCostAndUsageCommand({
          TimePeriod: period,
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost"],
          GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        });
        const response = await client.send(command);

        const items: { service: string; amount: number; unit: string }[] = [];
        for (const result of response.ResultsByTime || []) {
          for (const group of result.Groups || []) {
            const service = group.Keys?.[0] || "Unknown";
            const amount = parseFloat(
              group.Metrics?.UnblendedCost?.Amount || "0",
            );
            const unit = group.Metrics?.UnblendedCost?.Unit || "USD";

            const existing = items.find((i) => i.service === service);
            if (existing) {
              existing.amount += amount;
            } else {
              items.push({ service, amount, unit });
            }
          }
        }

        const total = items.reduce((sum, i) => sum + i.amount, 0);
        const data: z.infer<typeof CostByServiceSchema>[] = items
          .map((i) => ({
            service: i.service,
            amount: Math.round(i.amount * 100) / 100,
            unit: i.unit,
            percentage: total > 0
              ? Math.round((i.amount / total) * 10000) / 100
              : 0,
          }))
          .sort((a, b) => b.amount - a.amount);

        const handle = await context.writeResource(
          "costs",
          `by-service-${args.days}d`,
          {
            region: context.globalArgs.region,
            queryType: "cost_by_service",
            data,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Found {count} services with spend in last {days} days",
          { count: data.length, days: args.days },
        );
        return { dataHandles: [handle] };
      },
    },

    get_cost_by_usage_type: {
      description: "Break down a single service's spend by usage type",
      arguments: z.object({
        service: z.string().describe("AWS service name to drill into"),
        days: z
          .number()
          .default(30)
          .describe("Number of days to look back"),
      }),
      execute: async (
        args: { service: string; days: number },
        context: MethodContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const client = new CostExplorerClient({
          region: context.globalArgs.region,
        });
        const period = formatPeriod(args.days);

        const command = new GetCostAndUsageCommand({
          TimePeriod: period,
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost"],
          Filter: {
            Dimensions: { Key: "SERVICE", Values: [args.service] },
          },
          GroupBy: [{ Type: "DIMENSION", Key: "USAGE_TYPE" }],
        });
        const response = await client.send(command);

        const items: { usageType: string; amount: number; unit: string }[] = [];
        for (const result of response.ResultsByTime || []) {
          for (const group of result.Groups || []) {
            const usageType = group.Keys?.[0] || "Unknown";
            const amount = parseFloat(
              group.Metrics?.UnblendedCost?.Amount || "0",
            );
            const unit = group.Metrics?.UnblendedCost?.Unit || "USD";

            const existing = items.find((i) => i.usageType === usageType);
            if (existing) {
              existing.amount += amount;
            } else {
              items.push({ usageType, amount, unit });
            }
          }
        }

        const data: z.infer<typeof CostByUsageTypeSchema>[] = items
          .map((i) => ({
            usageType: i.usageType,
            amount: Math.round(i.amount * 100) / 100,
            unit: i.unit,
          }))
          .sort((a, b) => b.amount - a.amount);

        const handle = await context.writeResource(
          "costs",
          `by-usage-type-${args.days}d`,
          {
            region: context.globalArgs.region,
            queryType: "cost_by_usage_type",
            data,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Found {count} usage types for {service} in last {days} days",
          { count: data.length, service: args.service, days: args.days },
        );
        return { dataHandles: [handle] };
      },
    },

    get_cost_trend: {
      description:
        "Show daily cost trend and determine if spend is increasing, decreasing, or stable",
      arguments: z.object({
        days: z
          .number()
          .default(30)
          .describe("Number of days to look back"),
      }),
      execute: async (
        args: { days: number },
        context: MethodContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const client = new CostExplorerClient({
          region: context.globalArgs.region,
        });
        const period = formatPeriod(args.days);

        const command = new GetCostAndUsageCommand({
          TimePeriod: period,
          Granularity: "DAILY",
          Metrics: ["UnblendedCost"],
        });
        const response = await client.send(command);

        const dataPoints: z.infer<typeof CostTrendDataPointSchema>[] = [];
        for (const result of response.ResultsByTime || []) {
          const date = result.TimePeriod?.Start || "unknown";
          const amount = parseFloat(
            result.Total?.UnblendedCost?.Amount || "0",
          );
          dataPoints.push({
            date,
            amount: Math.round(amount * 100) / 100,
          });
        }

        // Determine trend by comparing first-half average to second-half average
        let trend = "stable";
        if (dataPoints.length >= 2) {
          const mid = Math.floor(dataPoints.length / 2);
          const firstHalf = dataPoints.slice(0, mid);
          const secondHalf = dataPoints.slice(mid);

          const avgFirst = firstHalf.reduce((s, p) => s + p.amount, 0) /
            firstHalf.length;
          const avgSecond = secondHalf.reduce((s, p) => s + p.amount, 0) /
            secondHalf.length;

          const changePercent = avgFirst > 0
            ? ((avgSecond - avgFirst) / avgFirst) * 100
            : 0;

          if (changePercent > 10) {
            trend = "increasing";
          } else if (changePercent < -10) {
            trend = "decreasing";
          }
        }

        const data: z.infer<typeof CostTrendSchema> = { dataPoints, trend };

        const handle = await context.writeResource(
          "costs",
          `trend-${args.days}d`,
          {
            region: context.globalArgs.region,
            queryType: "cost_trend",
            data,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Cost trend over {days} days: {trend} ({count} data points)",
          { days: args.days, trend, count: dataPoints.length },
        );
        return { dataHandles: [handle] };
      },
    },

    get_top_cost_drivers: {
      description:
        "Identify the top cost drivers by service and usage type combination",
      arguments: z.object({
        days: z
          .number()
          .default(30)
          .describe("Number of days to look back"),
        limit: z
          .number()
          .default(20)
          .describe("Maximum number of cost drivers to return"),
      }),
      execute: async (
        args: { days: number; limit: number },
        context: MethodContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const client = new CostExplorerClient({
          region: context.globalArgs.region,
        });
        const period = formatPeriod(args.days);

        const command = new GetCostAndUsageCommand({
          TimePeriod: period,
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost"],
          GroupBy: [
            { Type: "DIMENSION", Key: "SERVICE" },
            { Type: "DIMENSION", Key: "USAGE_TYPE" },
          ],
        });
        const response = await client.send(command);

        const items: {
          service: string;
          usageType: string;
          amount: number;
          unit: string;
        }[] = [];
        for (const result of response.ResultsByTime || []) {
          for (const group of result.Groups || []) {
            const service = group.Keys?.[0] || "Unknown";
            const usageType = group.Keys?.[1] || "Unknown";
            const amount = parseFloat(
              group.Metrics?.UnblendedCost?.Amount || "0",
            );
            const unit = group.Metrics?.UnblendedCost?.Unit || "USD";

            const key = `${service}|${usageType}`;
            const existing = items.find(
              (i) => `${i.service}|${i.usageType}` === key,
            );
            if (existing) {
              existing.amount += amount;
            } else {
              items.push({ service, usageType, amount, unit });
            }
          }
        }

        const data: z.infer<typeof CostDriverSchema>[] = items
          .map((i) => ({
            service: i.service,
            usageType: i.usageType,
            amount: Math.round(i.amount * 100) / 100,
            unit: i.unit,
          }))
          .sort((a, b) => b.amount - a.amount)
          .slice(0, args.limit);

        const handle = await context.writeResource(
          "costs",
          `top-drivers-${args.days}d`,
          {
            region: context.globalArgs.region,
            queryType: "top_cost_drivers",
            data,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Found top {limit} cost drivers over {days} days",
          { limit: data.length, days: args.days },
        );
        return { dataHandles: [handle] };
      },
    },

    get_cost_comparison: {
      description:
        "Compare costs between current and previous period by service",
      arguments: z.object({
        days: z
          .number()
          .default(30)
          .describe("Period length in days"),
      }),
      execute: async (
        args: { days: number },
        context: MethodContext,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const client = new CostExplorerClient({
          region: context.globalArgs.region,
        });

        const now = new Date();
        const currentStart = new Date(now);
        currentStart.setDate(currentStart.getDate() - args.days);
        const previousStart = new Date(currentStart);
        previousStart.setDate(previousStart.getDate() - args.days);

        const fmt = (d: Date): string => d.toISOString().slice(0, 10);

        const queryPeriod = async (
          start: Date,
          end: Date,
        ): Promise<Map<string, number>> => {
          const command = new GetCostAndUsageCommand({
            TimePeriod: { Start: fmt(start), End: fmt(end) },
            Granularity: "MONTHLY",
            Metrics: ["UnblendedCost"],
            GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
          });
          const response = await client.send(command);

          const services = new Map<string, number>();
          for (const result of response.ResultsByTime || []) {
            for (const group of result.Groups || []) {
              const service = group.Keys?.[0] || "Unknown";
              const amount = parseFloat(
                group.Metrics?.UnblendedCost?.Amount || "0",
              );
              services.set(
                service,
                (services.get(service) || 0) + amount,
              );
            }
          }
          return services;
        };

        const currentServices = await queryPeriod(currentStart, now);
        const previousServices = await queryPeriod(
          previousStart,
          currentStart,
        );

        // Merge all service names
        const allServices = new Set([
          ...currentServices.keys(),
          ...previousServices.keys(),
        ]);

        const services: Array<{
          service: string;
          currentAmount: number;
          previousAmount: number;
          delta: number;
          deltaPercent: number;
        }> = [];

        let currentTotal = 0;
        let previousTotal = 0;

        for (const service of allServices) {
          const current =
            Math.round((currentServices.get(service) || 0) * 100) / 100;
          const previous =
            Math.round((previousServices.get(service) || 0) * 100) / 100;
          const delta = Math.round((current - previous) * 100) / 100;
          const deltaPercent = previous > 0
            ? Math.round(((current - previous) / previous) * 10000) / 100
            : current > 0
            ? 100
            : 0;

          currentTotal += current;
          previousTotal += previous;
          services.push({
            service,
            currentAmount: current,
            previousAmount: previous,
            delta,
            deltaPercent,
          });
        }

        services.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

        const totalDelta = Math.round((currentTotal - previousTotal) * 100) /
          100;
        const totalDeltaPercent = previousTotal > 0
          ? Math.round(
            ((currentTotal - previousTotal) / previousTotal) * 10000,
          ) / 100
          : 0;

        const data = {
          currentPeriod: {
            start: fmt(currentStart),
            end: fmt(now),
            total: Math.round(currentTotal * 100) / 100,
          },
          previousPeriod: {
            start: fmt(previousStart),
            end: fmt(currentStart),
            total: Math.round(previousTotal * 100) / 100,
          },
          totalDelta,
          totalDeltaPercent,
          services,
        };

        const handle = await context.writeResource(
          "costs",
          `comparison-${args.days}d`,
          {
            region: context.globalArgs.region,
            queryType: "cost_comparison",
            data,
            fetchedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Cost comparison over {days}d: {delta} ({deltaPercent}%)",
          {
            days: args.days,
            delta: totalDelta.toFixed(2),
            deltaPercent: totalDeltaPercent.toFixed(1),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
