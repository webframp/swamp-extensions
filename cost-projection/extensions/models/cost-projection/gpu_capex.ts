/**
 * GPU Capex Cost Projection — on-premises / colocated hardware scenarios.
 *
 * Converts a capital hardware purchase into a synthetic recurring cost via
 * amortization, adds facility/staff/maintenance expenses, and normalizes to
 * $/GPU-hour for comparison against cloud and rental alternatives.
 *
 * Every assumption (useful life, utilization, PUE, failure rate) is stored as
 * an explicit named field. The model surfaces disagreements, not hides them —
 * when someone says "capex is cheaper," the response is "under which
 * assumptions?"
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

const DepreciationMethodEnum = z.enum(["straight-line"]);

const ScenarioSchema = z.object({
  name: z.string().min(1),
  site: z.string().optional(),

  gpuModel: z.string().min(1),
  gpuCount: z.number().int().positive(),
  gpuCostPerUnit: z.number().positive(),
  serverCost: z.number().nonnegative(),
  networkingCost: z.number().nonnegative(),
  totalHardwareCost: z.number().positive(),

  usefulLifeMonths: z.number().int().positive(),
  residualValuePct: z.number().min(0).max(100).default(0),
  depreciationMethod: DepreciationMethodEnum.default("straight-line"),

  coloCostPerKwMonth: z.number().nonnegative(),
  powerDrawKw: z.number().positive(),
  pue: z.number().min(1).default(1.4),
  networkBandwidthCostPerMonth: z.number().nonnegative().default(0),

  staffFteAllocation: z.number().min(0).max(10).default(0),
  staffCostPerFteMonth: z.number().nonnegative().default(0),

  failureRatePctPerYear: z.number().min(0).max(100).default(3),
  spareBudgetPerMonth: z.number().nonnegative().default(0),
  warrantyMonths: z.number().int().nonnegative().default(36),

  targetUtilizationPct: z.number().min(1).max(100).default(90),
  hoursPerDay: z.number().min(1).max(24).default(24),
  daysPerMonth: z.number().min(1).max(31).default(30),

  apiComparisonRatePerMToken: z.number().nonnegative().optional(),
  estimatedTokensPerGpuHour: z.number().nonnegative().optional(),

  currency: z.string().default("USD"),
  notes: z.string().optional(),
  quotedAt: z.string().optional(),
});

const ProjectionSchema = z.object({
  scenarioName: z.string(),
  computedAt: z.string(),

  costPerGpuHour: z.number(),
  costPerGpuHourAtTargetUtil: z.number(),

  monthlyDepreciation: z.number(),
  monthlyFacilityCost: z.number(),
  monthlyNetworkCost: z.number(),
  monthlyStaffCost: z.number(),
  monthlyMaintenanceCost: z.number(),
  monthlyTotalCost: z.number(),

  annualTotalCost: z.number(),
  totalCostOfOwnership: z.number(),

  breakEvenTokensPerMonth: z.number().optional(),
  breakEvenRequestsPerMonth: z.number().optional(),

  effectiveHoursPerMonth: z.number(),
  effectiveGpuHoursPerMonth: z.number(),
  usefulLifeMonths: z.number(),
  residualValue: z.number(),
  totalGpuCount: z.number(),
});

const SensitivityRowSchema = z.object({
  usefulLifeMonths: z.number(),
  utilizationPct: z.number(),
  costPerGpuHour: z.number(),
  monthlyTotalCost: z.number(),
});

const SensitivitySchema = z.object({
  scenarioName: z.string(),
  computedAt: z.string(),
  matrix: z.array(SensitivityRowSchema),
});

// =============================================================================
// Projection Logic
// =============================================================================

interface ScenarioInput {
  name: string;
  gpuCount: number;
  totalHardwareCost: number;
  usefulLifeMonths: number;
  residualValuePct: number;
  coloCostPerKwMonth: number;
  powerDrawKw: number;
  pue: number;
  networkBandwidthCostPerMonth: number;
  staffFteAllocation: number;
  staffCostPerFteMonth: number;
  failureRatePctPerYear: number;
  spareBudgetPerMonth: number;
  targetUtilizationPct: number;
  hoursPerDay: number;
  daysPerMonth: number;
  apiComparisonRatePerMToken?: number;
  estimatedTokensPerGpuHour?: number;
}

function computeProjection(s: ScenarioInput) {
  // Amortization (straight-line)
  const depreciableAmount = s.totalHardwareCost *
    (1 - s.residualValuePct / 100);
  const monthlyDepreciation = depreciableAmount / s.usefulLifeMonths;
  const residualValue = s.totalHardwareCost * (s.residualValuePct / 100);

  // Facility
  const effectivePowerKw = s.powerDrawKw * s.pue;
  const monthlyFacilityCost = effectivePowerKw * s.coloCostPerKwMonth;

  // Network
  const monthlyNetworkCost = s.networkBandwidthCostPerMonth;

  // Staff
  const monthlyStaffCost = s.staffFteAllocation * s.staffCostPerFteMonth;

  // Maintenance (blended over useful life)
  const annualReplacementCost = s.totalHardwareCost *
    (s.failureRatePctPerYear / 100);
  const monthlyMaintenanceCost = s.spareBudgetPerMonth +
    annualReplacementCost / 12;

  // Total
  const monthlyTotalCost = monthlyDepreciation +
    monthlyFacilityCost +
    monthlyNetworkCost +
    monthlyStaffCost +
    monthlyMaintenanceCost;

  // Normalization
  const effectiveHoursPerMonth = s.hoursPerDay * s.daysPerMonth;
  const effectiveGpuHoursPerMonth = effectiveHoursPerMonth * s.gpuCount *
    (s.targetUtilizationPct / 100);
  const costPerGpuHour = monthlyTotalCost /
    (effectiveHoursPerMonth * s.gpuCount);
  const costPerGpuHourAtTargetUtil = monthlyTotalCost /
    effectiveGpuHoursPerMonth;

  const totalCostOfOwnership = monthlyTotalCost * s.usefulLifeMonths;

  let breakEvenTokensPerMonth: number | undefined;
  let breakEvenRequestsPerMonth: number | undefined;
  if (s.apiComparisonRatePerMToken) {
    breakEvenTokensPerMonth = monthlyTotalCost /
      (s.apiComparisonRatePerMToken / 1_000_000);
    breakEvenRequestsPerMonth = Math.ceil(breakEvenTokensPerMonth / 4000);
  }

  return {
    scenarioName: s.name,
    computedAt: new Date().toISOString(),
    costPerGpuHour,
    costPerGpuHourAtTargetUtil,
    monthlyDepreciation,
    monthlyFacilityCost,
    monthlyNetworkCost,
    monthlyStaffCost,
    monthlyMaintenanceCost,
    monthlyTotalCost,
    annualTotalCost: monthlyTotalCost * 12,
    totalCostOfOwnership,
    breakEvenTokensPerMonth,
    breakEvenRequestsPerMonth,
    effectiveHoursPerMonth,
    effectiveGpuHoursPerMonth,
    usefulLifeMonths: s.usefulLifeMonths,
    residualValue,
    totalGpuCount: s.gpuCount,
  };
}

function computeSensitivity(
  s: ScenarioInput,
  usefulLifeRange: number[],
  utilizationRange: number[],
) {
  const matrix: Array<{
    usefulLifeMonths: number;
    utilizationPct: number;
    costPerGpuHour: number;
    monthlyTotalCost: number;
  }> = [];

  for (const life of usefulLifeRange) {
    for (const util of utilizationRange) {
      const variant = {
        ...s,
        usefulLifeMonths: life,
        targetUtilizationPct: util,
      };
      const proj = computeProjection(variant);
      matrix.push({
        usefulLifeMonths: life,
        utilizationPct: util,
        costPerGpuHour: proj.costPerGpuHourAtTargetUtil,
        monthlyTotalCost: proj.monthlyTotalCost,
      });
    }
  }

  return {
    scenarioName: s.name,
    computedAt: new Date().toISOString(),
    matrix,
  };
}

// =============================================================================
// Model
// =============================================================================

/** GPU capex inference cost projection model with amortization. */
export const model = {
  type: "@webframp/cost-projection/gpu-capex",
  version: "2026.08.01.1",
  globalArguments: z.object({}),
  reports: ["@webframp/cost-projection-comparison"],

  resources: {
    scenario: {
      description:
        "Capex GPU inference scenario — hardware costs, amortization " +
        "assumptions, facility expenses, staffing, and maintenance budget.",
      schema: ScenarioSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    projection: {
      description:
        "Computed cost projection with amortized hardware normalized to " +
        "$/GPU-hour. Every assumption that drives the number is surfaced.",
      schema: ProjectionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    sensitivity: {
      description:
        "Sensitivity matrix showing $/GPU-hour across multiple utilization " +
        "and useful-life assumptions. Identifies crossover points.",
      schema: SensitivitySchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    record: {
      description:
        "Record a capex GPU inference scenario and compute its projection. " +
        "totalHardwareCost should equal gpuCostPerUnit × gpuCount + " +
        "serverCost + networkingCost. All scenarios in a comparison must " +
        "share a currency. For per-token break-even, provide " +
        "apiComparisonRatePerMToken and estimatedTokensPerGpuHour.",
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
          "Recorded capex scenario '{name}': ${hw} hardware, {life}mo life, " +
            "{gpus} GPUs → ${costPerGpuHour}/GPU-hr (at {util}% util)",
          {
            name: scenario.name,
            hw: scenario.totalHardwareCost,
            life: scenario.usefulLifeMonths,
            gpus: scenario.gpuCount,
            costPerGpuHour: projection.costPerGpuHourAtTargetUtil.toFixed(4),
            util: scenario.targetUtilizationPct,
          },
        );

        return { dataHandles: [scenarioHandle, projectionHandle] };
      },
    },

    project: {
      description: "Re-compute the projection from the stored scenario.",
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
        ctx.logger.info(
          "Re-projected '{name}': ${costPerGpuHour}/GPU-hr",
          {
            name: scenario.name,
            costPerGpuHour: projection.costPerGpuHourAtTargetUtil.toFixed(4),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    update_hardware_cost: {
      description:
        "Revise the total hardware cost (e.g. after a new vendor quote) " +
        "without re-entering all other assumptions. Automatically re-runs " +
        "projection.",
      arguments: z.object({
        totalHardwareCost: z.number().positive(),
        gpuCostPerUnit: z.number().positive().optional(),
        quotedAt: z.string().optional(),
      }),
      execute: async (
        args: {
          totalHardwareCost: number;
          gpuCostPerUnit?: number;
          quotedAt?: string;
        },
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
          totalHardwareCost: args.totalHardwareCost,
          gpuCostPerUnit: args.gpuCostPerUnit ?? scenario.gpuCostPerUnit,
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
          "Updated hardware cost to ${hw}, re-projected: ${costPerGpuHour}/GPU-hr",
          {
            hw: args.totalHardwareCost,
            costPerGpuHour: projection.costPerGpuHourAtTargetUtil.toFixed(4),
          },
        );

        return { dataHandles: [scenarioHandle, projectionHandle] };
      },
    },

    sensitivity: {
      description:
        "Run the projection across a matrix of utilization and useful-life " +
        "assumptions. Identifies under which conditions capex wins or loses " +
        "against alternatives. Default ranges: 24/36/48/60 months life, " +
        "60/75/85/95% utilization.",
      arguments: z.object({
        usefulLifeMonthsRange: z
          .array(z.number().int().positive())
          .default([24, 36, 48, 60]),
        utilizationPctRange: z
          .array(z.number().min(1).max(100))
          .default([60, 75, 85, 95]),
      }),
      execute: async (
        args: {
          usefulLifeMonthsRange: number[];
          utilizationPctRange: number[];
        },
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

        const result = computeSensitivity(
          scenario,
          args.usefulLifeMonthsRange,
          args.utilizationPctRange,
        );

        const handle = await ctx.writeResource(
          "sensitivity",
          "sensitivity",
          result,
        );

        ctx.logger.info(
          "Sensitivity analysis for '{name}': {rows} combinations computed",
          {
            name: scenario.name,
            rows: result.matrix.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
