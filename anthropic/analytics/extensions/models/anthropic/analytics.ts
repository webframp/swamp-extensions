/**
 * Claude Enterprise Analytics model for swamp.
 *
 * Observes enterprise analytics: DAU/WAU/MAU, seat counts, pending
 * invites, project/skill/connector adoption, and cost on usage-based
 * plans. Requires an Analytics API key (scope read:analytics) created
 * by the primary owner in claude.ai.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  analyticsKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Analytics API key (scope read:analytics) from claude.ai (use vault reference)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// --- Enterprise Analytics ---

const AnalyticsMetricSchema = z.object({
  name: z.string(),
  value: z.unknown(),
  period: z.string().nullable(),
  breakdown: z.record(z.string(), z.unknown()).nullable(),
});

const AnalyticsSnapshotSchema = z.object({
  metrics: z.array(AnalyticsMetricSchema),
  count: z.number(),
  dataRefreshedAt: z.string().nullable(),
  fetchedAt: z.string(),
});

const SeatCountSchema = z.object({
  total: z.number().nullable(),
  active: z.number().nullable(),
  pending_invites: z.number().nullable(),
  dau: z.number().nullable(),
  wau: z.number().nullable(),
  mau: z.number().nullable(),
  fetchedAt: z.string(),
});

const AdoptionMetricsSchema = z.object({
  projects: z.number().nullable(),
  skills: z.number().nullable(),
  connectors: z.number().nullable(),
  fetchedAt: z.string(),
});

// =============================================================================
// API Client
// =============================================================================

const BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

/** Make an authenticated request to the Analytics API. */
async function analyticsRequest(
  key: string,
  path: string,
  params?: Record<string, string>,
): Promise<any> {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-api-key": key,
      "anthropic-version": API_VERSION,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Analytics API ${path}: ${resp.status} ${body}`);
  }
  return resp.json();
}

// =============================================================================
// Context Type
// =============================================================================

type ModelContext = {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: { info: (msg: string, props: Record<string, unknown>) => void };
};

// =============================================================================
// Model Definition
// =============================================================================

/** Claude Enterprise Analytics — seat counts, adoption, DAU/WAU/MAU via the Analytics API. */
export const model = {
  type: "@webframp/anthropic/analytics",
  version: "2026.07.02.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    snapshot: {
      description:
        "Raw analytics snapshot — all metrics returned by the analytics endpoint",
      schema: AnalyticsSnapshotSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    seats: {
      description:
        "Seat allocation and activity counts (total, active, pending, DAU/WAU/MAU)",
      schema: SeatCountSchema,
      lifetime: "1h" as const,
      garbageCollection: 10,
    },
    adoption: {
      description:
        "Feature adoption metrics (projects, skills, connectors in use)",
      schema: AdoptionMetricsSchema,
      lifetime: "6h" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    collect_analytics: {
      description:
        "Collect the full enterprise analytics snapshot. Stores raw metrics and extracts seat/adoption data into separate resources.",
      arguments: z.object({
        startDate: z.string().optional().describe(
          "Start date (YYYY-MM-DD). Defaults to 30 days ago.",
        ),
        endDate: z.string().optional().describe(
          "End date (YYYY-MM-DD). Defaults to today.",
        ),
      }),
      execute: async (
        args: { startDate?: string; endDate?: string },
        ctx: ModelContext,
      ) => {
        const key = ctx.globalArgs.analyticsKey;
        const handles: { name: string }[] = [];

        const params: Record<string, string> = {};
        if (args.startDate) params.start_date = args.startDate;
        if (args.endDate) params.end_date = args.endDate;

        const data = await analyticsRequest(
          key,
          "/v1/organizations/analytics",
          params,
        );

        const rawMetrics = data.data ?? data.metrics ?? data;
        const metrics = Array.isArray(rawMetrics)
          ? rawMetrics.map((m: any) => ({
            name: m.name ?? m.metric ?? "",
            value: m.value ?? null,
            period: m.period ?? null,
            breakdown: m.breakdown ?? null,
          }))
          : Object.entries(rawMetrics).map(([name, value]) => ({
            name,
            value,
            period: null,
            breakdown: null,
          }));

        handles.push(
          await ctx.writeResource("snapshot", "latest", {
            metrics,
            count: metrics.length,
            dataRefreshedAt: data.data_refreshed_at ?? null,
            fetchedAt: new Date().toISOString(),
          }),
        );

        const findMetric = (name: string): any =>
          metrics.find((m) => m.name.toLowerCase().includes(name.toLowerCase()))
            ?.value ?? null;

        handles.push(
          await ctx.writeResource("seats", "current", {
            total: findMetric("total_seats") ?? findMetric("seats"),
            active: findMetric("active_seats") ?? findMetric("active_users"),
            pending_invites: findMetric("pending_invites") ??
              findMetric("pending"),
            dau: findMetric("dau") ?? findMetric("daily_active"),
            wau: findMetric("wau") ?? findMetric("weekly_active"),
            mau: findMetric("mau") ?? findMetric("monthly_active"),
            fetchedAt: new Date().toISOString(),
          }),
        );

        handles.push(
          await ctx.writeResource("adoption", "current", {
            projects: findMetric("projects") ?? findMetric("project_count"),
            skills: findMetric("skills") ?? findMetric("skill_count"),
            connectors: findMetric("connectors") ??
              findMetric("connector_count"),
            fetchedAt: new Date().toISOString(),
          }),
        );

        ctx.logger.info(
          "Collected {count} analytics metrics",
          { count: metrics.length },
        );
        return { dataHandles: handles };
      },
    },
  },
};
