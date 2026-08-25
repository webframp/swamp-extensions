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

const EXTENSION_NAME = "@webframp/cost-projection";

// =============================================================================
// Schemas
// =============================================================================

const DepreciationMethodEnum = z.enum(["straight-line"]);

const ScenarioSchema = z.object({
  name: z.string().min(1).describe("Human-readable name for this scenario"),
  site: z.string().optional().describe("Physical site or datacenter location"),

  gpuModel: z.string().min(1).describe("GPU model (e.g. H100, A100)"),
  gpuCount: z.number().int().positive().describe("Number of GPUs purchased"),
  gpuCostPerUnit: z.number().positive().describe("Purchase price per GPU"),
  serverCost: z.number().nonnegative().describe(
    "Server/chassis hardware cost, excluding GPUs",
  ),
  networkingCost: z.number().nonnegative().describe(
    "Networking hardware cost (switches, NICs, cabling)",
  ),
  totalHardwareCost: z.number().positive().describe(
    "Total upfront hardware cost; should equal gpuCostPerUnit * gpuCount + serverCost + networkingCost",
  ),

  usefulLifeMonths: z.number().int().positive().describe(
    "Amortization period for the hardware, in months",
  ),
  residualValuePct: z.number().min(0).max(100).default(0).describe(
    "Expected resale/residual value at end of useful life, as a percentage of totalHardwareCost",
  ),
  depreciationMethod: DepreciationMethodEnum.default("straight-line").describe(
    "Depreciation method used to amortize the hardware cost",
  ),

  coloCostPerKwMonth: z.number().nonnegative().describe(
    "Colocation/power cost per kW per month",
  ),
  powerDrawKw: z.number().positive().describe(
    "IT power draw of the hardware, in kW",
  ),
  pue: z.number().min(1).default(1.4).describe(
    "Power usage effectiveness multiplier applied to powerDrawKw to account for cooling/overhead",
  ),
  networkBandwidthCostPerMonth: z.number().nonnegative().default(0).describe(
    "Flat monthly network bandwidth cost",
  ),

  staffFteAllocation: z.number().min(0).max(10).default(0).describe(
    "Fraction of staff FTE allocated to operating this hardware",
  ),
  staffCostPerFteMonth: z.number().nonnegative().default(0).describe(
    "Fully-loaded staff cost per FTE per month",
  ),

  failureRatePctPerYear: z.number().min(0).max(100).default(3).describe(
    "Expected annual hardware failure rate, as a percentage of totalHardwareCost, used to estimate replacement spend",
  ),
  spareBudgetPerMonth: z.number().nonnegative().default(0).describe(
    "Flat monthly budget reserved for spare parts",
  ),
  warrantyMonths: z.number().int().nonnegative().default(36).describe(
    "Manufacturer warranty coverage, in months",
  ),

  targetUtilizationPct: z.number().min(1).max(100).default(90).describe(
    "Target GPU utilization used to compute the effective cost per GPU-hour",
  ),
  hoursPerDay: z.number().min(1).max(24).default(24).describe(
    "Expected hours of hardware availability per day",
  ),
  daysPerMonth: z.number().min(1).max(31).default(30).describe(
    "Expected days of hardware availability per month",
  ),

  apiComparisonRatePerMToken: z.number().nonnegative().optional().describe(
    "Comparable managed-API rate per million tokens, used to compute break-even",
  ),
  estimatedTokensPerGpuHour: z.number().nonnegative().optional().describe(
    "Estimated throughput in tokens per GPU-hour, from benchmarks or model card figures",
  ),

  currency: z.string().default("USD").describe(
    "Currency of all cost fields in this scenario",
  ),
  notes: z.string().optional().describe("Free-form notes about this scenario"),
  quotedAt: z.string().optional().describe(
    "Date the hardware cost was quoted (YYYY-MM-DD)",
  ),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const ProjectionSchema = z.object({
  scenarioName: z.string().describe(
    "Name of the scenario this projection was computed from",
  ),
  computedAt: z.string().describe(
    "ISO 8601 timestamp when the projection was computed",
  ),

  costPerGpuHour: z.number().describe(
    "Normalized total cost per GPU-hour assuming full-time availability",
  ),
  costPerGpuHourAtTargetUtil: z.number().describe(
    "Normalized total cost per GPU-hour at targetUtilizationPct",
  ),

  monthlyDepreciation: z.number().describe("Monthly amortized hardware cost"),
  monthlyFacilityCost: z.number().describe("Monthly power/colocation cost"),
  monthlyNetworkCost: z.number().describe("Monthly network bandwidth cost"),
  monthlyStaffCost: z.number().describe("Monthly staffing cost"),
  monthlyMaintenanceCost: z.number().describe(
    "Monthly maintenance/spares cost",
  ),
  monthlyTotalCost: z.number().describe("Sum of all monthly cost components"),

  annualTotalCost: z.number().describe("monthlyTotalCost annualized (x12)"),
  totalCostOfOwnership: z.number().describe(
    "monthlyTotalCost multiplied by usefulLifeMonths",
  ),

  breakEvenTokensPerMonth: z.number().optional().describe(
    "Monthly token volume at which this scenario's cost equals the comparable API cost",
  ),
  breakEvenRequestsPerMonth: z.number().optional().describe(
    "breakEvenTokensPerMonth expressed as an approximate request count (4000 tokens/request)",
  ),

  effectiveHoursPerMonth: z.number().describe("hoursPerDay * daysPerMonth"),
  effectiveGpuHoursPerMonth: z.number().describe(
    "effectiveHoursPerMonth * totalGpuCount * targetUtilizationPct",
  ),
  usefulLifeMonths: z.number().describe("Amortization period used, in months"),
  residualValue: z.number().describe(
    "Expected residual value of the hardware at end of useful life",
  ),
  totalGpuCount: z.number().describe("Total number of GPUs in this scenario"),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const SensitivityRowSchema = z.object({
  usefulLifeMonths: z.number().describe(
    "Useful-life assumption for this matrix cell, in months",
  ),
  utilizationPct: z.number().describe(
    "Utilization assumption for this matrix cell, as a percentage",
  ),
  costPerGpuHour: z.number().describe(
    "Cost per GPU-hour under this cell's assumptions",
  ),
  monthlyTotalCost: z.number().describe(
    "Monthly total cost under this cell's assumptions",
  ),
});

const SensitivitySchema = z.object({
  scenarioName: z.string().describe(
    "Name of the scenario this sensitivity analysis was computed from",
  ),
  computedAt: z.string().describe(
    "ISO 8601 timestamp when the analysis was computed",
  ),
  matrix: z.array(SensitivityRowSchema).describe(
    "Cost per GPU-hour and monthly total cost across the useful-life × utilization grid",
  ),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
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
  version: "2026.08.25.1",
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
        const startMs = Date.now();
        const scenario = ScenarioSchema.parse(args);

        const scenarioHandle = await ctx.writeResource(
          "scenario",
          "scenario",
          {
            ...scenario,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );

        const projection = computeProjection(scenario);
        const projectionHandle = await ctx.writeResource(
          "projection",
          "projection",
          {
            ...projection,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
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
        const startMs = Date.now();
        const raw = await ctx.readResource!("scenario");
        if (!raw) throw new Error("No scenario recorded — run 'record' first");
        const scenario = ScenarioSchema.parse(raw);
        const projection = computeProjection(scenario);
        const handle = await ctx.writeResource(
          "projection",
          "projection",
          {
            ...projection,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
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
        totalHardwareCost: z.number().positive().describe(
          "New total upfront hardware cost",
        ),
        gpuCostPerUnit: z.number().positive().optional().describe(
          "New purchase price per GPU; leave unset to keep the stored value",
        ),
        quotedAt: z.string().optional().describe(
          "Date the new cost was quoted (YYYY-MM-DD); defaults to today",
        ),
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
        const startMs = Date.now();
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
          {
            ...updated,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
        );

        const projection = computeProjection(updated);
        const projectionHandle = await ctx.writeResource(
          "projection",
          "projection",
          {
            ...projection,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
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
          .min(1)
          .default([24, 36, 48, 60])
          .describe("Useful-life assumptions (months) to sweep across"),
        utilizationPctRange: z
          .array(z.number().min(1).max(100))
          .min(1)
          .default([60, 75, 85, 95])
          .describe("Utilization assumptions (percent) to sweep across"),
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
        const startMs = Date.now();
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
          {
            ...result,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          },
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
