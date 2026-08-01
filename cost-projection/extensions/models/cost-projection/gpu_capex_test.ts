// GPU Capex Cost Projection Model Tests
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import {
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./gpu_capex.ts";

function makeContext() {
  return createModelTestContext({
    globalArgs: {},
    definition: { id: "test-id", name: "test-capex", version: 1, tags: {} },
  });
}

function findResource(resources: any[], specName: string) {
  return resources.find((r: any) => r.specName === specName);
}

function findAll(resources: any[], specName: string) {
  return resources.filter((r: any) => r.specName === specName);
}

const BASE = {
  name: "dc-east",
  gpuModel: "H100 SXM",
  gpuCount: 8,
  gpuCostPerUnit: 30000,
  serverCost: 40000,
  networkingCost: 10000,
  totalHardwareCost: 290000,
  usefulLifeMonths: 36,
  residualValuePct: 0,
  depreciationMethod: "straight-line",
  coloCostPerKwMonth: 150,
  powerDrawKw: 10,
  pue: 1.4,
  networkBandwidthCostPerMonth: 500,
  staffFteAllocation: 0.25,
  staffCostPerFteMonth: 15000,
  failureRatePctPerYear: 3,
  spareBudgetPerMonth: 200,
  warrantyMonths: 36,
  targetUtilizationPct: 90,
  hoursPerDay: 24,
  daysPerMonth: 30,
};

// =============================================================================
// Model Structure
// =============================================================================

Deno.test("model type string", () => {
  assertEquals(model.type, "@webframp/cost-projection/gpu-capex");
});

Deno.test("model version CalVer", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("resources defined", () => {
  assertEquals("scenario" in model.resources, true);
  assertEquals("projection" in model.resources, true);
  assertEquals("sensitivity" in model.resources, true);
});

Deno.test("methods defined", () => {
  assertEquals("record" in model.methods, true);
  assertEquals("project" in model.methods, true);
  assertEquals("update_hardware_cost" in model.methods, true);
  assertEquals("sensitivity" in model.methods, true);
});

// =============================================================================
// record: amortization math
// =============================================================================

Deno.test("record: monthly depreciation straight-line", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(
    { ...BASE, totalHardwareCost: 360000, usefulLifeMonths: 36 },
    context as any,
  );
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.monthlyDepreciation, 10000);
});

Deno.test("record: residual value reduces depreciation", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(
    {
      ...BASE,
      totalHardwareCost: 360000,
      usefulLifeMonths: 36,
      residualValuePct: 10,
    },
    context as any,
  );
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.monthlyDepreciation, 9000);
  assertEquals(p.residualValue, 36000);
});

Deno.test("record: facility cost with PUE", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(
    { ...BASE, powerDrawKw: 10, pue: 1.5, coloCostPerKwMonth: 100 },
    context as any,
  );
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.monthlyFacilityCost, 1500);
});

Deno.test("record: staff cost from FTE allocation", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(
    { ...BASE, staffFteAllocation: 0.5, staffCostPerFteMonth: 20000 },
    context as any,
  );
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.monthlyStaffCost, 10000);
});

Deno.test("record: maintenance includes failure budget", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(
    {
      ...BASE,
      totalHardwareCost: 240000,
      failureRatePctPerYear: 5,
      spareBudgetPerMonth: 300,
    },
    context as any,
  );
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.monthlyMaintenanceCost, 1300);
});

Deno.test("record: costPerGpuHour vs atTargetUtil", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute({
    ...BASE,
    totalHardwareCost: 36000,
    usefulLifeMonths: 36,
    coloCostPerKwMonth: 0,
    powerDrawKw: 1,
    pue: 1,
    networkBandwidthCostPerMonth: 0,
    staffFteAllocation: 0,
    staffCostPerFteMonth: 0,
    failureRatePctPerYear: 0,
    spareBudgetPerMonth: 0,
    gpuCount: 1,
    targetUtilizationPct: 50,
  }, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.costPerGpuHour, 1000 / 720);
  assertEquals(p.costPerGpuHourAtTargetUtil, 1000 / (720 * 0.5));
});

Deno.test("record: totalCostOfOwnership", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.totalCostOfOwnership, p.monthlyTotalCost * 36);
});

Deno.test("record: writes scenario + projection", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  const r = getWrittenResources();
  assertEquals(r.length, 2);
  assertEquals(r[0].specName, "scenario");
  assertEquals(r[1].specName, "projection");
});

// =============================================================================
// project
// =============================================================================

Deno.test("project: re-computes same result", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  await model.methods.project.execute({}, context as any);
  const projs = findAll(getWrittenResources(), "projection");
  assertEquals(projs.length, 2);
  assertEquals(
    projs[0].data.costPerGpuHourAtTargetUtil,
    projs[1].data.costPerGpuHourAtTargetUtil,
  );
});

Deno.test("project: throws without scenario", async () => {
  const { context } = makeContext();
  await assertRejects(
    () => model.methods.project.execute({}, context as any),
    Error,
    "No scenario recorded",
  );
});

// =============================================================================
// update_hardware_cost
// =============================================================================

Deno.test("update_hardware_cost: updates and re-projects", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  await model.methods.update_hardware_cost.execute(
    { totalHardwareCost: 400000 },
    context as any,
  );
  const projs = findAll(getWrittenResources(), "projection");
  assertEquals(projs[projs.length - 1].data.monthlyDepreciation, 400000 / 36);
});

Deno.test("update_hardware_cost: optionally updates gpuCostPerUnit", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  await model.methods.update_hardware_cost.execute(
    { totalHardwareCost: 400000, gpuCostPerUnit: 40000 },
    context as any,
  );
  const scens = findAll(getWrittenResources(), "scenario");
  assertEquals(scens[scens.length - 1].data.gpuCostPerUnit, 40000);
});

Deno.test("update_hardware_cost: throws without scenario", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      model.methods.update_hardware_cost.execute(
        { totalHardwareCost: 300000 },
        context as any,
      ),
    Error,
    "No scenario recorded",
  );
});

// =============================================================================
// sensitivity
// =============================================================================

Deno.test("sensitivity: correct matrix dimensions", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  await model.methods.sensitivity.execute(
    { usefulLifeMonthsRange: [24, 36, 48], utilizationPctRange: [60, 80, 95] },
    context as any,
  );
  const s = findResource(getWrittenResources(), "sensitivity").data;
  assertEquals(s.matrix.length, 9);
});

Deno.test("sensitivity: higher util = lower cost", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  await model.methods.sensitivity.execute(
    { usefulLifeMonthsRange: [36], utilizationPctRange: [50, 95] },
    context as any,
  );
  const s = findResource(getWrittenResources(), "sensitivity").data;
  const low = s.matrix.find((r: any) => r.utilizationPct === 50);
  const high = s.matrix.find((r: any) => r.utilizationPct === 95);
  assertEquals(high.costPerGpuHour < low.costPerGpuHour, true);
});

Deno.test("sensitivity: longer life = lower cost", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  await model.methods.sensitivity.execute(
    { usefulLifeMonthsRange: [24, 60], utilizationPctRange: [90] },
    context as any,
  );
  const s = findResource(getWrittenResources(), "sensitivity").data;
  const short = s.matrix.find((r: any) => r.usefulLifeMonths === 24);
  const long = s.matrix.find((r: any) => r.usefulLifeMonths === 60);
  assertEquals(long.costPerGpuHour < short.costPerGpuHour, true);
  assertEquals(long.monthlyTotalCost < short.monthlyTotalCost, true);
});

Deno.test("sensitivity: throws without scenario", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      model.methods.sensitivity.execute(
        { usefulLifeMonthsRange: [36], utilizationPctRange: [90] },
        context as any,
      ),
    Error,
    "No scenario recorded",
  );
});

// =============================================================================
// Schema validation
// =============================================================================

Deno.test("schema: rejects targetUtilizationPct=0", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({
      ...BASE,
      targetUtilizationPct: 0,
    }).success,
    false,
  );
});

Deno.test("schema: rejects hoursPerDay=0", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({ ...BASE, hoursPerDay: 0 })
      .success,
    false,
  );
});

Deno.test("schema: rejects totalHardwareCost=0", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({ ...BASE, totalHardwareCost: 0 })
      .success,
    false,
  );
});

Deno.test("schema: rejects usefulLifeMonths=0", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({ ...BASE, usefulLifeMonths: 0 })
      .success,
    false,
  );
});

Deno.test("schema: rejects residualValuePct>100", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({ ...BASE, residualValuePct: 101 })
      .success,
    false,
  );
});

Deno.test("sensitivity schema: rejects utilizationPctRange with 0", () => {
  assertEquals(
    model.methods.sensitivity.arguments.safeParse(
      { usefulLifeMonthsRange: [36], utilizationPctRange: [0, 50] },
    ).success,
    false,
  );
});
