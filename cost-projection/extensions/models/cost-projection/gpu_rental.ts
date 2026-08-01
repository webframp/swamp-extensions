/**
 * GPU Rental Cost Projection — third-party GPU provider scenarios.
 *
 * Stores user-entered pricing from GPU rental providers (CoreWeave, Lambda
 * Labs, RunPod, Vast.ai, etc.) and computes a normalized $/GPU-hour projection.
 * Simpler cost structure than hyperscalers — typically a per-GPU hourly rate
 * with optional commitment discounts.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

const CommitmentTermEnum = z.enum([
  "none",
  "monthly",
  "3-month",
  "6-month",
  "annual",
  "other",
]);

const ScenarioSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  region: z.string().optional(),

  gpuModel: z.string().min(1),
  gpuCount: z.number().int().positive(),
  gpuMemoryGb: z.number().positive().optional(),

  ratePerGpuHour: z.number().positive(),
  currency: z.string().default("USD"),
  commitmentTerm: CommitmentTermEnum.default("none"),
  commitmentDiscountPct: z.number().min(0).max(100).default(0),

  hoursPerDay: z.number().min(1).max(24).default(24),
  daysPerMonth: z.number().min(1).max(31).default(30),

  storageGb: z.number().nonnegative().default(0),
  storageRatePerGbMonth: z.number().nonnegative().default(0),
  networkEgressGbMonth: z.number().nonnegative().default(0),
  networkEgressRatePerGb: z.number().nonnegative().default(0),

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
  costPerGpuHourListRate: z.number(),

  monthlyGpuCost: z.number(),
  monthlyStorageCost: z.number(),
  monthlyNetworkCost: z.number(),
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
  ratePerGpuHour: number;
  commitmentDiscountPct: number;
  gpuCount: number;
  hoursPerDay: number;
  daysPerMonth: number;
  storageGb: number;
  storageRatePerGbMonth: number;
  networkEgressGbMonth: number;
  networkEgressRatePerGb: number;
  apiComparisonRatePerMToken?: number;
  estimatedTokensPerGpuHour?: number;
}

function computeProjection(s: ScenarioInput) {
  const effectiveRatePerGpuHour = s.ratePerGpuHour *
    (1 - s.commitmentDiscountPct / 100);
  const effectiveHoursPerMonth = s.hoursPerDay * s.daysPerMonth;
  const monthlyGpuCost = effectiveRatePerGpuHour * effectiveHoursPerMonth *
    s.gpuCount;
  const monthlyStorageCost = s.storageGb * s.storageRatePerGbMonth;
  const monthlyNetworkCost = s.networkEgressGbMonth * s.networkEgressRatePerGb;
  const monthlyTotalCost = monthlyGpuCost + monthlyStorageCost +
    monthlyNetworkCost;

  const costPerGpuHour = monthlyTotalCost /
    (effectiveHoursPerMonth * s.gpuCount);
  const costPerGpuHourListRate =
    (s.ratePerGpuHour * effectiveHoursPerMonth * s.gpuCount +
      monthlyStorageCost +
      monthlyNetworkCost) /
    (effectiveHoursPerMonth * s.gpuCount);

  let breakEvenTokensPerMonth: number | undefined;
  let breakEvenRequestsPerMonth: number | undefined;
  if (s.apiComparisonRatePerMToken && s.estimatedTokensPerGpuHour) {
    breakEvenTokensPerMonth = monthlyTotalCost /
      (s.apiComparisonRatePerMToken / 1_000_000);
    breakEvenRequestsPerMonth = Math.ceil(breakEvenTokensPerMonth / 4000);
  }

  return {
    scenarioName: s.name,
    computedAt: new Date().toISOString(),
    costPerGpuHour,
    costPerGpuHourListRate,
    monthlyGpuCost,
    monthlyStorageCost,
    monthlyNetworkCost,
    monthlyTotalCost,
    annualTotalCost: monthlyTotalCost * 12,
    breakEvenTokensPerMonth,
    breakEvenRequestsPerMonth,
    effectiveHoursPerMonth,
    totalGpuCount: s.gpuCount,
  };
}

// =============================================================================
// Model
// =============================================================================

export const model = {
  type: "@webframp/cost-projection/gpu-rental",
  version: "2026.07.31.1",
  globalArguments: z.object({}),

  resources: {
    scenario: {
      description:
        "GPU rental inference scenario — provider, GPU type, hourly rate, " +
        "commitment discount, and additional costs.",
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
      description: "Record a GPU rental scenario and compute its projection. " +
        "All scenarios in a comparison must share a currency — convert rates " +
        "to your base currency before entering them. For per-token break-even, " +
        "provide apiComparisonRatePerMToken and estimatedTokensPerGpuHour " +
        "(from vLLM benchmarks or model card throughput figures).",
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
          "Recorded rental scenario '{name}': ${rate}/GPU-hr ({provider}), " +
            "{gpus} GPUs → ${costPerGpuHour}/GPU-hr effective",
          {
            name: scenario.name,
            rate: scenario.ratePerGpuHour,
            provider: scenario.provider,
            gpus: scenario.gpuCount,
            costPerGpuHour: projection.costPerGpuHour.toFixed(4),
          },
        );

        return { dataHandles: [scenarioHandle, projectionHandle] };
      },
    },

    project: {
      description:
        "Re-compute the projection from the stored scenario. Use after " +
        "update_rate to regenerate output.",
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
        "Update the per-GPU hourly rate and quotedAt without re-entering " +
        "all other fields. Automatically re-runs projection.",
      arguments: z.object({
        ratePerGpuHour: z.number().positive(),
        quotedAt: z.string().optional(),
      }),
      execute: async (
        args: { ratePerGpuHour: number; quotedAt?: string },
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
          ratePerGpuHour: args.ratePerGpuHour,
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
          "Updated rate to ${rate}/GPU-hr, re-projected: ${costPerGpuHour}/GPU-hr",
          {
            rate: args.ratePerGpuHour,
            costPerGpuHour: projection.costPerGpuHour.toFixed(4),
          },
        );

        return { dataHandles: [scenarioHandle, projectionHandle] };
      },
    },
  },
};
