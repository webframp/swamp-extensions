// Scenario Comparison Report Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { createReportTestContext } from "@systeminit/swamp-testing";
import { report } from "./scenario_comparison.ts";

function artifact(
  modelType: string,
  modelId: string,
  name: "scenario" | "projection",
  attributes: Record<string, unknown>,
) {
  const content = new TextEncoder().encode(JSON.stringify(attributes));
  return {
    modelType,
    modelId,
    data: {
      name,
      kind: "resource" as const,
      dataId: `${modelId}-${name}`,
      version: 1,
      size: content.length,
      contentType: "application/json",
    },
    content,
  };
}

const CLOUD = "@webframp/cost-projection/gpu-cloud";
const RENTAL = "@webframp/cost-projection/gpu-rental";
const CAPEX = "@webframp/cost-projection/gpu-capex";

const RECENT = new Date().toISOString().slice(0, 10);
const STALE_DATE = new Date(Date.now() - 200 * 86400000).toISOString().slice(
  0,
  10,
);

function onDemandArtifacts() {
  return [
    artifact(CLOUD, "on-demand-b300", "scenario", {
      name: "on-demand-b300",
      gpuModel: "NVIDIA B300",
      capacityModel: "on-demand",
      hoursPerDay: 24,
      currency: "USD",
      quotedAt: RECENT,
    }),
    artifact(CLOUD, "on-demand-b300", "projection", {
      scenarioName: "on-demand-b300",
      computedAt: RECENT,
      costPerGpuHour: 12.3125,
      costPerInstanceHour: 98.5,
      monthlyComputeCost: 70920,
      monthlyStorageCost: 0,
      monthlyTransferCost: 0,
      monthlyManagementCost: 0,
      monthlyTotalCost: 70920,
      annualTotalCost: 851040,
      effectiveHoursPerMonth: 720,
      totalGpuCount: 8,
    }),
  ];
}

function capacityBlockArtifacts() {
  return [
    artifact(CLOUD, "capacity-block-b300", "scenario", {
      name: "capacity-block-b300",
      gpuModel: "NVIDIA B300",
      capacityModel: "capacity-block",
      hoursPerDay: 24,
      currency: "USD",
      quotedAt: RECENT,
    }),
    artifact(CLOUD, "capacity-block-b300", "projection", {
      scenarioName: "capacity-block-b300",
      computedAt: RECENT,
      costPerGpuHour: 7.625,
      costPerInstanceHour: 61,
      monthlyComputeCost: 43920,
      monthlyStorageCost: 0,
      monthlyTransferCost: 0,
      monthlyManagementCost: 0,
      monthlyTotalCost: 43920,
      annualTotalCost: 527040,
      effectiveHoursPerMonth: 720,
      totalGpuCount: 8,
    }),
  ];
}

Deno.test("scope is model, not workspace", () => {
  assertEquals(report.scope, "model");
});

Deno.test("no data: returns guidance message", async () => {
  const { context } = createReportTestContext({
    scope: "model",
    dataArtifacts: [],
  });

  const result = await report.execute(context);
  assertStringIncludes(result.markdown, "No cost projection scenarios found");
  assertEquals(result.json.scenarios, []);
});

Deno.test("compares sibling instances across the repo, not just the triggering one", async () => {
  const { context } = createReportTestContext({
    scope: "model",
    // The triggering instance is on-demand-b300, but the report must also
    // pick up capacity-block-b300 — a completely different model instance.
    modelType: CLOUD,
    modelId: "on-demand-b300",
    dataArtifacts: [...onDemandArtifacts(), ...capacityBlockArtifacts()],
  });

  const result = await report.execute(context);
  const scenarios = result.json.scenarios as Array<{ name: string }>;

  assertEquals(scenarios.length, 2);
  assertStringIncludes(result.markdown, "on-demand-b300");
  assertStringIncludes(result.markdown, "capacity-block-b300");
  assertStringIncludes(result.markdown, "$12.31");
  assertStringIncludes(result.markdown, "$7.63");

  const cheapest = result.json.cheapest as { name: string };
  assertEquals(cheapest.name, "capacity-block-b300");

  const crossovers = result.json.crossovers as Array<{ statement: string }>;
  assertEquals(crossovers.length, 1);
  assertStringIncludes(crossovers[0].statement, "capacity-block-b300");
  assertStringIncludes(crossovers[0].statement, "on-demand-b300");
  assertStringIncludes(crossovers[0].statement, "61%");
  assertStringIncludes(result.markdown, "Crossover Analysis");
});

Deno.test("includes instances from all three model types", async () => {
  const { context } = createReportTestContext({
    scope: "model",
    dataArtifacts: [
      ...onDemandArtifacts(),
      artifact(RENTAL, "coreweave-h100", "scenario", {
        name: "coreweave-h100",
        gpuModel: "NVIDIA H100 SXM",
        commitmentTerm: "none",
        provider: "coreweave",
        currency: "USD",
        quotedAt: RECENT,
      }),
      artifact(RENTAL, "coreweave-h100", "projection", {
        scenarioName: "coreweave-h100",
        computedAt: RECENT,
        costPerGpuHour: 2.49,
        costPerGpuHourListRate: 2.49,
        monthlyGpuCost: 14342.4,
        monthlyStorageCost: 0,
        monthlyNetworkCost: 0,
        monthlyTotalCost: 14342.4,
        annualTotalCost: 172108.8,
        effectiveHoursPerMonth: 720,
        totalGpuCount: 8,
      }),
      artifact(CAPEX, "dc-east-b300", "scenario", {
        name: "dc-east-b300",
        gpuModel: "NVIDIA B300",
        usefulLifeMonths: 36,
        targetUtilizationPct: 90,
        currency: "USD",
        quotedAt: RECENT,
      }),
      artifact(CAPEX, "dc-east-b300", "projection", {
        scenarioName: "dc-east-b300",
        computedAt: RECENT,
        // Deliberately different from costPerGpuHourAtTargetUtil below, so
        // the test catches a regression that reads the wrong field.
        costPerGpuHour: 3.5,
        costPerGpuHourAtTargetUtil: 4,
        monthlyDepreciation: 9444.44,
        monthlyFacilityCost: 500,
        monthlyNetworkCost: 0,
        monthlyStaffCost: 0,
        monthlyMaintenanceCost: 0,
        monthlyTotalCost: 9944.44,
        annualTotalCost: 119333.28,
        totalCostOfOwnership: 358000,
        effectiveHoursPerMonth: 720,
        effectiveGpuHoursPerMonth: 5184,
        usefulLifeMonths: 36,
        residualValue: 0,
        totalGpuCount: 8,
      }),
      // Noise: a data artifact from an unrelated extension, also named
      // "projection" — must not be swept into the comparison.
      artifact("@webframp/other/thing", "unrelated", "projection", {
        scenarioName: "should-not-appear",
        costPerGpuHour: 0.01,
        monthlyTotalCost: 1,
        annualTotalCost: 12,
      }),
    ],
  });

  const result = await report.execute(context);
  const scenarios = result.json.scenarios as Array<
    { name: string; type: string; costPerGpuHour: number }
  >;

  assertEquals(scenarios.length, 3);
  assertEquals(
    new Set(scenarios.map((s) => s.type)),
    new Set(["cloud", "rental", "capex"]),
  );
  assertStringIncludes(result.markdown, "coreweave-h100");
  assertStringIncludes(result.markdown, "dc-east-b300");
  for (const s of scenarios) {
    assertEquals(s.name === "should-not-appear", false);
  }

  // Capex must report the target-utilization-adjusted rate ($4.00), not the
  // raw costPerGpuHour ($3.50) — regression check for the field-selection
  // branch in scenario_comparison.ts.
  const capex = scenarios.find((s) => s.name === "dc-east-b300")!;
  assertEquals(capex.costPerGpuHour, 4);
  assertStringIncludes(result.markdown, "$4.00");
});

Deno.test("flags mixed currencies across scenarios", async () => {
  const eur = artifact(RENTAL, "eu-rental", "scenario", {
    name: "eu-rental",
    gpuModel: "NVIDIA H100 SXM",
    currency: "EUR",
    quotedAt: RECENT,
  });
  const eurProjection = artifact(RENTAL, "eu-rental", "projection", {
    scenarioName: "eu-rental",
    costPerGpuHour: 2,
    costPerGpuHourListRate: 2,
    monthlyTotalCost: 11520,
    annualTotalCost: 138240,
  });

  const { context } = createReportTestContext({
    scope: "model",
    dataArtifacts: [...onDemandArtifacts(), eur, eurProjection],
  });

  const result = await report.execute(context);
  const warnings = result.json.warnings as string[];
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "Mixed currencies");
  assertStringIncludes(result.markdown, "Mixed currencies");
});

Deno.test("flags stale pricing", async () => {
  const staleScenario = artifact(CLOUD, "old-quote", "scenario", {
    name: "old-quote",
    gpuModel: "NVIDIA A100",
    capacityModel: "on-demand",
    currency: "USD",
    quotedAt: STALE_DATE,
  });
  const staleProjection = artifact(CLOUD, "old-quote", "projection", {
    scenarioName: "old-quote",
    costPerGpuHour: 5,
    monthlyTotalCost: 3600,
    annualTotalCost: 43200,
  });

  const { context } = createReportTestContext({
    scope: "model",
    dataArtifacts: [staleScenario, staleProjection],
  });

  const result = await report.execute(context);
  assertStringIncludes(result.markdown, "Stale Pricing");
  assertStringIncludes(result.markdown, "old-quote");
});

Deno.test("degrades gracefully when the repo-wide scan fails, instead of throwing", async () => {
  const { context } = createReportTestContext({
    scope: "model",
    dataArtifacts: onDemandArtifacts(),
  });

  // Simulate a findAllGlobal failure (e.g. a filesystem hiccup). Since this
  // report now runs after every method call on three model types, it must
  // not let a scan-layer error propagate and mark an otherwise-successful
  // record/project/update_rate run as failed.
  context.dataRepository.findAllGlobal = () => {
    throw new Error("simulated scan failure");
  };

  const result = await report.execute(context);
  assertStringIncludes(result.markdown, "Unable to scan");
  assertEquals(result.json.scenarios, []);
  assertEquals(
    (result.json.warnings as string[]).some((w) =>
      w.includes("simulated scan failure")
    ),
    true,
  );
});
