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

import { z } from "npm:zod@4.4.3";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "npm:@aws-sdk/client-cost-explorer@3.1114.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1114.0";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  region: z
    .string()
    .default("us-east-1")
    .describe("AWS region for the Cost Explorer endpoint"),
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

// --- Per-spec schemas (flat, typed, one per query shape) ---

const CostTrendDataPointSchema = z.object({
  date: z.string(),
  amount: z.number(),
});

const CostTrendOutputSchema = z.object({
  dataPoints: z.array(CostTrendDataPointSchema),
  trend: z.string(),
  totalCost: z.number(),
  days: z.number(),
  fetchedAt: z.string(),
});

const CostByServiceItemSchema = z.object({
  service: z.string(),
  amount: z.number(),
  unit: z.string(),
  percentage: z.number(),
});

const CostByServiceOutputSchema = z.object({
  services: z.array(CostByServiceItemSchema),
  totalCost: z.number(),
  days: z.number(),
  fetchedAt: z.string(),
});

const CostByUsageTypeItemSchema = z.object({
  usageType: z.string(),
  amount: z.number(),
  unit: z.string(),
});

const CostByUsageTypeOutputSchema = z.object({
  service: z.string(),
  usageTypes: z.array(CostByUsageTypeItemSchema),
  totalCost: z.number(),
  days: z.number(),
  fetchedAt: z.string(),
});

const CostDriverItemSchema = z.object({
  service: z.string(),
  usageType: z.string(),
  amount: z.number(),
  unit: z.string(),
});

const CostDriversOutputSchema = z.object({
  drivers: z.array(CostDriverItemSchema),
  totalCost: z.number(),
  days: z.number(),
  fetchedAt: z.string(),
});

const CostComparisonServiceSchema = z.object({
  service: z.string(),
  currentAmount: z.number(),
  previousAmount: z.number(),
  delta: z.number(),
  deltaPercent: z.number(),
});

const CostComparisonOutputSchema = z.object({
  currentPeriod: z.object({
    start: z.string(),
    end: z.string(),
    total: z.number(),
  }),
  previousPeriod: z.object({
    start: z.string(),
    end: z.string(),
    total: z.number(),
  }),
  totalDelta: z.number(),
  totalDeltaPercent: z.number(),
  services: z.array(CostComparisonServiceSchema),
  days: z.number(),
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
  globalArgs: GlobalArgs;
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
  version: "2026.08.20.1",
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
      toVersion: "2026.08.10.1",
      description:
        "Add totalCost field to get_cost_trend output (sum of dataPoints)",
      upgradeAttributes: (old: Record<string, unknown>) => {
        if (old.queryType !== "cost_trend") return old;
        const data = old.data as Record<string, unknown> | undefined;
        if (data && Array.isArray(data.dataPoints) && !("totalCost" in data)) {
          const sum = (data.dataPoints as Array<{ amount?: number }>).reduce(
            (acc, p) =>
              acc +
              (typeof p.amount === "number" && Number.isFinite(p.amount)
                ? p.amount
                : 0),
            0,
          );
          data.totalCost = Math.round(sum * 100) / 100;
        }
        return old;
      },
    },
    {
      toVersion: "2026.08.13.1",
      description:
        "Flatten output: replace polymorphic 'costs' spec with typed per-query " +
        "specs (costTrend, costByService, costByUsageType, costDrivers, " +
        "costComparison). Existing cached 'costs' resources are migrated to " +
        "their new spec shape by extracting the nested 'data' field to top level.",
      upgradeAttributes: (old: Record<string, unknown>) => {
        // Migrate old envelope shape { region, queryType, data, fetchedAt }
        // to the new flat shape by picking known fields to top level.
        // Resources already in the new shape (no queryType) pass through unchanged.
        if (!("queryType" in old) || !("data" in old)) return old;
        const data = old.data;
        const fetchedAt = typeof old.fetchedAt === "string"
          ? old.fetchedAt
          : new Date().toISOString();

        // Guard: data must be a usable value. If null/undefined/primitive,
        // leave the resource as-is for the legacy normalizer branch to handle.
        if (data == null || typeof data !== "object") return old;

        if (old.queryType === "cost_trend" && !Array.isArray(data)) {
          const d = data as Record<string, unknown>;
          return {
            dataPoints: d.dataPoints,
            trend: d.trend,
            totalCost: typeof d.totalCost === "number" ? d.totalCost : 0,
            days: typeof d.days === "number" ? d.days : 7,
            fetchedAt,
          };
        }
        if (old.queryType === "cost_by_service" && Array.isArray(data)) {
          const totalCost = (data as Array<{ amount?: number }>).reduce(
            (s, i) => s + (typeof i.amount === "number" ? i.amount : 0),
            0,
          );
          return {
            services: data,
            totalCost: Math.round(totalCost * 100) / 100,
            days: 30,
            fetchedAt,
          };
        }
        if (old.queryType === "cost_by_usage_type" && Array.isArray(data)) {
          const totalCost = (data as Array<{ amount?: number }>).reduce(
            (s, i) => s + (typeof i.amount === "number" ? i.amount : 0),
            0,
          );
          return {
            service: "",
            usageTypes: data,
            totalCost: Math.round(totalCost * 100) / 100,
            days: 30,
            fetchedAt,
          };
        }
        if (old.queryType === "top_cost_drivers" && Array.isArray(data)) {
          const totalCost = (data as Array<{ amount?: number }>).reduce(
            (s, i) => s + (typeof i.amount === "number" ? i.amount : 0),
            0,
          );
          return {
            drivers: data,
            totalCost: Math.round(totalCost * 100) / 100,
            days: 30,
            fetchedAt,
          };
        }
        if (
          old.queryType === "cost_comparison" && !Array.isArray(data)
        ) {
          const d = data as Record<string, unknown>;
          return {
            currentPeriod: d.currentPeriod,
            previousPeriod: d.previousPeriod,
            totalDelta: d.totalDelta,
            totalDeltaPercent: d.totalDeltaPercent,
            services: d.services,
            days: typeof d.days === "number" ? d.days : 30,
            fetchedAt,
          };
        }
        return old;
      },
    },
    {
      toVersion: "2026.08.20.1",
      description: "Dependency bump, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    costTrend: {
      description: "Daily cost trend with direction indicator",
      schema: CostTrendOutputSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    costByService: {
      description: "Cost breakdown by AWS service",
      schema: CostByServiceOutputSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    costByUsageType: {
      description: "Cost breakdown by usage type for a single service",
      schema: CostByUsageTypeOutputSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    costDrivers: {
      description: "Top cost drivers by service and usage type combination",
      schema: CostDriversOutputSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    costComparison: {
      description: "Period-over-period cost comparison by service",
      schema: CostComparisonOutputSchema,
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
        const client = new CostExplorerClient(
          makeClientConfig(context.globalArgs),
        );
        try {
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

          const totalCost = items.reduce((sum, i) => sum + i.amount, 0);
          const services = items
            .map((i) => ({
              service: i.service,
              amount: Math.round(i.amount * 100) / 100,
              unit: i.unit,
              percentage: totalCost > 0
                ? Math.round((i.amount / totalCost) * 10000) / 100
                : 0,
            }))
            .sort((a, b) => b.amount - a.amount);

          const handle = await context.writeResource(
            "costByService",
            `${args.days}d`,
            {
              services,
              totalCost: Math.round(totalCost * 100) / 100,
              days: args.days,
              fetchedAt: new Date().toISOString(),
            },
          );

          context.logger.info(
            "Found {count} services with spend in last {days} days",
            { count: services.length, days: args.days },
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
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
        const client = new CostExplorerClient(
          makeClientConfig(context.globalArgs),
        );
        try {
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

          const items: { usageType: string; amount: number; unit: string }[] =
            [];
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

          const usageTypes = items
            .map((i) => ({
              usageType: i.usageType,
              amount: Math.round(i.amount * 100) / 100,
              unit: i.unit,
            }))
            .sort((a, b) => b.amount - a.amount);

          const totalCost = items.reduce((s, i) => s + i.amount, 0);

          const handle = await context.writeResource(
            "costByUsageType",
            `${args.days}d`,
            {
              service: args.service,
              usageTypes,
              totalCost: Math.round(totalCost * 100) / 100,
              days: args.days,
              fetchedAt: new Date().toISOString(),
            },
          );

          context.logger.info(
            "Found {count} usage types for {service} in last {days} days",
            {
              count: usageTypes.length,
              service: args.service,
              days: args.days,
            },
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
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
        const client = new CostExplorerClient(
          makeClientConfig(context.globalArgs),
        );
        try {
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

          const totalCost = Math.round(
            dataPoints.reduce(
              (s, p) => s + (Number.isFinite(p.amount) ? p.amount : 0),
              0,
            ) * 100,
          ) / 100;

          const handle = await context.writeResource(
            "costTrend",
            `${args.days}d`,
            {
              dataPoints,
              trend,
              totalCost,
              days: args.days,
              fetchedAt: new Date().toISOString(),
            },
          );

          context.logger.info(
            "Cost trend over {days} days: {trend} ({count} data points)",
            { days: args.days, trend, count: dataPoints.length },
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
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
        const client = new CostExplorerClient(
          makeClientConfig(context.globalArgs),
        );
        try {
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

          const drivers = items
            .map((i) => ({
              service: i.service,
              usageType: i.usageType,
              amount: Math.round(i.amount * 100) / 100,
              unit: i.unit,
            }))
            .sort((a, b) => b.amount - a.amount)
            .slice(0, args.limit);

          const totalCost = items.reduce((s, i) => s + i.amount, 0);

          const handle = await context.writeResource(
            "costDrivers",
            `${args.days}d`,
            {
              drivers,
              totalCost: Math.round(totalCost * 100) / 100,
              days: args.days,
              fetchedAt: new Date().toISOString(),
            },
          );

          context.logger.info(
            "Found top {limit} cost drivers over {days} days",
            { limit: drivers.length, days: args.days },
          );
          return { dataHandles: [handle] };
        } finally {
          client.destroy();
        }
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
        const client = new CostExplorerClient(
          makeClientConfig(context.globalArgs),
        );
        try {
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

          const services: z.infer<typeof CostComparisonServiceSchema>[] = [];

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

          const handle = await context.writeResource(
            "costComparison",
            `${args.days}d`,
            {
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
              days: args.days,
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
        } finally {
          client.destroy();
        }
      },
    },
  },
};
