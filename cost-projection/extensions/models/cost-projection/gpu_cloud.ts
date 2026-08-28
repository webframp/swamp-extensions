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

const EXTENSION_NAME = "@webframp/cost-projection";

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
  name: z.string().min(1).describe("Human-readable name for this scenario"),
  provider: ProviderEnum.describe("Cloud provider hosting the GPU instance"),
  region: z.string().min(1).describe(
    "Cloud region for the instance (e.g. us-east-1)",
  ),

  instanceType: z.string().min(1).describe(
    "Cloud provider instance type or SKU",
  ),
  gpuCount: z.number().int().positive().describe("Number of GPUs per instance"),
  gpuModel: z.string().min(1).describe("GPU model (e.g. H100, A100)"),

  capacityModel: CapacityModelEnum.describe(
    "Pricing/commitment model under which the instance is purchased",
  ),
  commitmentTermMonths: z.number().nonnegative().optional().describe(
    "Length of the commitment term in months, if the capacity model requires one",
  ),

  instanceRatePerHour: z.number().positive().describe(
    "Quoted hourly rate per instance, in currency units",
  ),
  currency: z.string().default("USD").describe(
    "Currency of all rate fields in this scenario",
  ),

  hoursPerDay: z.number().min(1).max(24).default(24).describe(
    "Expected hours of instance utilization per day",
  ),
  daysPerMonth: z.number().min(1).max(31).default(30).describe(
    "Expected days of instance utilization per month",
  ),
  replicas: z.number().int().positive().default(1).describe(
    "Number of identical instances running concurrently",
  ),

  storageGb: z.number().nonnegative().default(0).describe(
    "Attached storage size per instance, in GB",
  ),
  storageRatePerGbMonth: z.number().nonnegative().default(0).describe(
    "Storage cost per GB per month",
  ),
  dataTransferGbMonth: z.number().nonnegative().default(0).describe(
    "Expected monthly data transfer volume, in GB",
  ),
  dataTransferRatePerGb: z.number().nonnegative().default(0).describe(
    "Data transfer cost per GB",
  ),
  managementFeePerMonth: z.number().nonnegative().default(0).describe(
    "Flat monthly management/platform fee, independent of replicas",
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
    "Normalized total cost per GPU-hour across all replicas",
  ),
  costPerInstanceHour: z.number().describe(
    "Normalized total cost per instance-hour across all replicas",
  ),

  monthlyComputeCost: z.number().describe(
    "Monthly compute cost across all replicas",
  ),
  monthlyStorageCost: z.number().describe(
    "Monthly storage cost across all replicas",
  ),
  monthlyTransferCost: z.number().describe("Monthly data transfer cost"),
  monthlyManagementCost: z.number().describe("Monthly flat management fee"),
  monthlyTotalCost: z.number().describe("Sum of all monthly cost components"),

  annualTotalCost: z.number().describe("monthlyTotalCost annualized (x12)"),

  breakEvenTokensPerMonth: z.number().optional().describe(
    "Monthly token volume at which self-hosting cost equals the comparable API cost",
  ),
  breakEvenRequestsPerMonth: z.number().optional().describe(
    "breakEvenTokensPerMonth expressed as an approximate request count (4000 tokens/request)",
  ),

  effectiveHoursPerMonth: z.number().describe("hoursPerDay * daysPerMonth"),
  totalGpuCount: z.number().describe("gpuCount * replicas"),
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
  if (s.apiComparisonRatePerMToken) {
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

/** GPU cloud inference cost projection model. */
export const model = {
  type: "@webframp/cost-projection/gpu-cloud",
  version: "2026.08.28.1",
  globalArguments: z.object({}),
  reports: ["@webframp/cost-projection-comparison"],

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
        "Update the instance hourly rate and quotedAt timestamp without " +
        "re-entering all other fields. Automatically re-runs projection.",
      arguments: z.object({
        instanceRatePerHour: z.number().positive().describe(
          "New quoted hourly rate per instance, in the scenario's currency",
        ),
        quotedAt: z.string().optional().describe(
          "Date the new rate was quoted (YYYY-MM-DD); defaults to today",
        ),
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
        const startMs = Date.now();
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
