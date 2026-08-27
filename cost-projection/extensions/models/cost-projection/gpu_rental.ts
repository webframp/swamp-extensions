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

const EXTENSION_NAME = "@webframp/cost-projection";

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
  name: z.string().min(1).describe("Human-readable name for this scenario"),
  provider: z.string().min(1).describe(
    "GPU rental provider name (e.g. CoreWeave, Lambda Labs)",
  ),
  region: z.string().optional().describe(
    "Provider region or datacenter location",
  ),

  gpuModel: z.string().min(1).describe("GPU model (e.g. H100, A100)"),
  gpuCount: z.number().int().positive().describe(
    "Number of GPUs in this scenario",
  ),
  gpuMemoryGb: z.number().positive().optional().describe(
    "Memory per GPU, in GB",
  ),

  ratePerGpuHour: z.number().positive().describe(
    "Quoted list price per GPU per hour",
  ),
  currency: z.string().default("USD").describe(
    "Currency of all rate fields in this scenario",
  ),
  commitmentTerm: CommitmentTermEnum.default("none").describe(
    "Commitment term the discounted rate is tied to",
  ),
  commitmentDiscountPct: z.number().min(0).max(100).default(0).describe(
    "Discount off ratePerGpuHour granted for the commitment term, as a percentage",
  ),

  hoursPerDay: z.number().min(1).max(24).default(24).describe(
    "Expected hours of GPU utilization per day",
  ),
  daysPerMonth: z.number().min(1).max(31).default(30).describe(
    "Expected days of GPU utilization per month",
  ),

  storageGb: z.number().nonnegative().default(0).describe(
    "Attached storage size, in GB",
  ),
  storageRatePerGbMonth: z.number().nonnegative().default(0).describe(
    "Storage cost per GB per month",
  ),
  networkEgressGbMonth: z.number().nonnegative().default(0).describe(
    "Expected monthly network egress volume, in GB",
  ),
  networkEgressRatePerGb: z.number().nonnegative().default(0).describe(
    "Network egress cost per GB",
  ),

  apiComparisonRatePerMToken: z.number().nonnegative().optional().describe(
    "Comparable managed-API rate per million tokens, used to compute break-even",
  ),
  estimatedTokensPerGpuHour: z.number().nonnegative().optional().describe(
    "Estimated throughput in tokens per GPU-hour, from benchmarks or model card figures",
  ),

  notes: z.string().optional().describe("Free-form notes about this scenario"),
  sourceUrl: z.string().optional().describe(
    "URL of the quote or pricing page this scenario is based on",
  ),
  quotedAt: z.string().optional().describe(
    "Date the rate was quoted (YYYY-MM-DD)",
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
    "Normalized total cost per GPU-hour after the commitment discount",
  ),
  costPerGpuHourListRate: z.number().describe(
    "Normalized total cost per GPU-hour at the undiscounted list rate",
  ),

  monthlyGpuCost: z.number().describe(
    "Monthly GPU rental cost after the commitment discount",
  ),
  monthlyStorageCost: z.number().describe("Monthly storage cost"),
  monthlyNetworkCost: z.number().describe("Monthly network egress cost"),
  monthlyTotalCost: z.number().describe("Sum of all monthly cost components"),
  annualTotalCost: z.number().describe("monthlyTotalCost annualized (x12)"),

  breakEvenTokensPerMonth: z.number().optional().describe(
    "Monthly token volume at which this scenario's cost equals the comparable API cost",
  ),
  breakEvenRequestsPerMonth: z.number().optional().describe(
    "breakEvenTokensPerMonth expressed as an approximate request count (4000 tokens/request)",
  ),

  effectiveHoursPerMonth: z.number().describe("hoursPerDay * daysPerMonth"),
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
  if (s.apiComparisonRatePerMToken) {
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

/** GPU rental inference cost projection model. */
export const model = {
  type: "@webframp/cost-projection/gpu-rental",
  version: "2026.08.26.3",
  globalArguments: z.object({}),
  reports: ["@webframp/cost-projection-comparison"],

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
        ratePerGpuHour: z.number().positive().describe(
          "New quoted list price per GPU per hour",
        ),
        quotedAt: z.string().optional().describe(
          "Date the new rate was quoted (YYYY-MM-DD); defaults to today",
        ),
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
        const startMs = Date.now();
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
