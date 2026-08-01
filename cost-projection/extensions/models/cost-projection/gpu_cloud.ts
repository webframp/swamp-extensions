/**
 * GPU Cloud Cost Projection — hyperscaler GPU instance scenarios.
 *
 * Stores user-entered pricing for cloud GPU instances (AWS, Azure, GCP) under
 * various capacity models (on-demand, reserved, FTP, Capacity Blocks) and
 * computes a normalized $/GPU-hour projection for cross-scenario comparison.
 *
 * No live API calls — rates are manually entered from quotes, pricing pages,
 * or account team conversations.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

const CapacityModelEnum = z.enum([
  "on-demand",
  "reserved-1yr",
  "reserved-3yr",
  "savings-plan",
  "flexible-training-plan",
  "capacity-block",
  "committed-use-1yr",
  "committed-use-3yr",
  "other",
]);

const ProviderEnum = z.enum(["aws", "azure", "gcp", "other"]);

const ScenarioSchema = z.object({
  name: z.string().min(1),
  provider: ProviderEnum,
  region: z.string().min(1),

  instanceType: z.string().min(1),
  gpuCount: z.number().int().positive(),
  gpuModel: z.string().min(1),

  capacityModel: CapacityModelEnum,
  commitmentTermMonths: z.number().nonnegative().optional(),

  instanceRatePerHour: z.number().positive(),
  currency: z.string().default("USD"),

  hoursPerDay: z.number().min(1).max(24).default(24),
  daysPerMonth: z.number().min(1).max(31).default(30),
  replicas: z.number().int().positive().default(1),

  storageGb: z.number().nonnegative().default(0),
  storageRatePerGbMonth: z.number().nonnegative().default(0),
  dataTransferGbMonth: z.number().nonnegative().default(0),
  dataTransferRatePerGb: z.number().nonnegative().default(0),
  managementFeePerMonth: z.number().nonnegative().default(0),

  apiComparisonRatePerMToken: z.number().nonnegative().optional(),
  estimatedTokensPerGpuHour: z.number().nonnegative().optional(),

  notes: z.string().optional(),
  sourceUrl: z.string().optional(),
  quotedAt: z.string().optional(),
});

const ProjectionSchema = z.object({
  scenarioName: z.string(),
  computedAt: z.string(),

  costPerGpuHour: z.number(),
  costPerInstanceHour: z.number(),

  monthlyComputeCost: z.number(),
  monthlyStorageCost: z.number(),
  monthlyTransferCost: z.number(),
  monthlyManagementCost: z.number(),
  monthlyTotalCost: z.number(),

  annualTotalCost: z.number(),

  breakEvenTokensPerMonth: z.number().optional(),
  breakEvenRequestsPerMonth: z.number().optional(),

  effectiveHoursPerMonth: z.number(),
  totalGpuCount: z.number(),
});

// =============================================================================
// Projection Logic
// =============================================================================

interface ScenarioInput {
  name: string;
  instanceRatePerHour: number;
  gpuCount: number;
  hoursPerDay: number;
  daysPerMonth: number;
  replicas: number;
  storageGb: number;
  storageRatePerGbMonth: number;
  dataTransferGbMonth: number;
  dataTransferRatePerGb: number;
  managementFeePerMonth: number;
  apiComparisonRatePerMToken?: number;
  estimatedTokensPerGpuHour?: number;
}

function computeProjection(s: ScenarioInput) {
  const effectiveHoursPerMonth = s.hoursPerDay * s.daysPerMonth;
  const monthlyComputeCost = s.instanceRatePerHour * effectiveHoursPerMonth *
    s.replicas;
  const monthlyStorageCost = s.storageGb * s.storageRatePerGbMonth * s.replicas;
  const monthlyTransferCost = s.dataTransferGbMonth * s.dataTransferRatePerGb;
  const monthlyManagementCost = s.managementFeePerMonth;
  const monthlyTotalCost = monthlyComputeCost +
    monthlyStorageCost +
    monthlyTransferCost +
    monthlyManagementCost;

  const totalGpuCount = s.gpuCount * s.replicas;
  const costPerInstanceHour = monthlyTotalCost /
    (effectiveHoursPerMonth * s.replicas);
  const costPerGpuHour = costPerInstanceHour / s.gpuCount;

  let breakEvenTokensPerMonth: number | undefined;
  let breakEvenRequestsPerMonth: number | undefined;
  if (s.apiComparisonRatePerMToken && s.estimatedTokensPerGpuHour) {
    // Break-even: at what monthly token volume does self-hosting equal API
    // monthlyTotalCost = tokens * apiRate / 1M
    breakEvenTokensPerMonth = monthlyTotalCost /
      (s.apiComparisonRatePerMToken / 1_000_000);
    breakEvenRequestsPerMonth = Math.ceil(breakEvenTokensPerMonth / 4000);
  }

  return {
    scenarioName: s.name,
    computedAt: new Date().toISOString(),
    costPerGpuHour,
    costPerInstanceHour,
    monthlyComputeCost,
    monthlyStorageCost,
    monthlyTransferCost,
    monthlyManagementCost,
    monthlyTotalCost,
    annualTotalCost: monthlyTotalCost * 12,
    breakEvenTokensPerMonth,
    breakEvenRequestsPerMonth,
    effectiveHoursPerMonth,
    totalGpuCount,
  };
}

// =============================================================================
// Model
// =============================================================================

export const model = {
  type: "@webframp/cost-projection/gpu-cloud",
  version: "2026.07.31.1",
  globalArguments: z.object({}),

  resources: {
    scenario: {
      description:
        "Cloud GPU inference scenario — instance type, capacity model, " +
        "rates, utilization, and additional costs.",
      schema: ScenarioSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    projection: {
      description:
        "Computed cost projection normalized to $/GPU-hour. Derived from " +
        "the scenario resource.",
      schema: ProjectionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    record: {
      description:
        "Record a cloud GPU inference scenario and compute its projection. " +
        "All scenarios in a comparison must share a currency — convert rates " +
        "to your base currency before entering them. For per-token break-even, " +
        "provide apiComparisonRatePerMToken (e.g. Bedrock/Anthropic API rate) " +
        "and estimatedTokensPerGpuHour (from vLLM benchmarks or model card " +
        "throughput figures). These are optional.",
      arguments: ScenarioSchema,
      execute: async (
        args: any,
        ctx: {
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (m: string, p: Record<string, unknown>) => void;
          };
        },
      ) => {
        const scenario = ScenarioSchema.parse(args);

        const scenarioHandle = await ctx.writeResource(
          "scenario",
          "scenario",
          scenario,
        );

        const projection = computeProjection(scenario);
        const projectionHandle = await ctx.writeResource(
          "projection",
          "projection",
          projection,
        );

        ctx.logger.info(
          "Recorded cloud scenario '{name}': ${rate}/hr, {gpus} GPUs × {replicas} replicas → ${costPerGpuHour}/GPU-hr",
          {
            name: scenario.name,
            rate: scenario.instanceRatePerHour,
            gpus: scenario.gpuCount,
            replicas: scenario.replicas,
            costPerGpuHour: projection.costPerGpuHour.toFixed(4),
          },
        );

        return { dataHandles: [scenarioHandle, projectionHandle] };
      },
    },

    project: {
      description:
        "Re-compute the projection from the stored scenario. Use after " +
        "update_rate to regenerate output without re-entering all inputs.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: {
          readResource:
            | ((name: string) => Promise<Record<string, unknown> | null>)
            | undefined;
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (m: string, p: Record<string, unknown>) => void;
          };
        },
      ) => {
        const raw = await ctx.readResource!("scenario");
        if (!raw) throw new Error("No scenario recorded — run 'record' first");
        const scenario = ScenarioSchema.parse(raw);
        const projection = computeProjection(scenario);
        const handle = await ctx.writeResource(
          "projection",
          "projection",
          projection,
        );
        ctx.logger.info("Re-projected '{name}': ${costPerGpuHour}/GPU-hr", {
          name: scenario.name,
          costPerGpuHour: projection.costPerGpuHour.toFixed(4),
        });
        return { dataHandles: [handle] };
      },
    },

    update_rate: {
      description:
        "Update the instance hourly rate and quotedAt timestamp without " +
        "re-entering all other fields. Automatically re-runs projection.",
      arguments: z.object({
        instanceRatePerHour: z.number().positive(),
        quotedAt: z.string().optional(),
      }),
      execute: async (
        args: { instanceRatePerHour: number; quotedAt?: string },
        ctx: {
          readResource:
            | ((name: string) => Promise<Record<string, unknown> | null>)
            | undefined;
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (m: string, p: Record<string, unknown>) => void;
          };
        },
      ) => {
        const raw = await ctx.readResource!("scenario");
        if (!raw) throw new Error("No scenario recorded — run 'record' first");
        const scenario = ScenarioSchema.parse(raw);

        const updated = {
          ...scenario,
          instanceRatePerHour: args.instanceRatePerHour,
          quotedAt: args.quotedAt ?? new Date().toISOString().slice(0, 10),
        };

        const scenarioHandle = await ctx.writeResource(
          "scenario",
          "scenario",
          updated,
        );

        const projection = computeProjection(updated);
        const projectionHandle = await ctx.writeResource(
          "projection",
          "projection",
          projection,
        );

        ctx.logger.info(
          "Updated rate to ${rate}/hr, re-projected: ${costPerGpuHour}/GPU-hr",
          {
            rate: args.instanceRatePerHour,
            costPerGpuHour: projection.costPerGpuHour.toFixed(4),
          },
        );

        return { dataHandles: [scenarioHandle, projectionHandle] };
      },
    },
  },
};
