// GPU Rental Cost Projection Model Tests
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import {
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./gpu_rental.ts";

function makeContext() {
  return createModelTestContext({
    globalArgs: {},
    definition: { id: "test-id", name: "test-rental", version: 1, tags: {} },
  });
}

function findResource(resources: any[], specName: string) {
  return resources.find((r: any) => r.specName === specName);
}

function findAll(resources: any[], specName: string) {
  return resources.filter((r: any) => r.specName === specName);
}

const BASE = {
  name: "test",
  provider: "coreweave",
  gpuModel: "H100 SXM",
  gpuCount: 8,
  ratePerGpuHour: 2.49,
  hoursPerDay: 24,
  daysPerMonth: 30,
  commitmentTerm: "none",
  commitmentDiscountPct: 0,
  storageGb: 0,
  storageRatePerGbMonth: 0,
  networkEgressGbMonth: 0,
  networkEgressRatePerGb: 0,
};

// =============================================================================
// Model Structure
// =============================================================================

Deno.test("model type string", () => {
  assertEquals(model.type, "@webframp/cost-projection/gpu-rental");
});

Deno.test("model version CalVer", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("resources defined", () => {
  assertEquals("scenario" in model.resources, true);
  assertEquals("projection" in model.resources, true);
});

Deno.test("methods defined", () => {
  assertEquals("record" in model.methods, true);
  assertEquals("project" in model.methods, true);
  assertEquals("update_rate" in model.methods, true);
});

// =============================================================================
// record: projection math
// =============================================================================

Deno.test("record: base case no discount", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.costPerGpuHour, 2.49);
  assertEquals(p.costPerGpuHourListRate, 2.49);
  assertEquals(p.monthlyGpuCost, 2.49 * 720 * 8);
  assertEquals(p.monthlyTotalCost, 2.49 * 720 * 8);
  assertEquals(p.totalGpuCount, 8);
});

Deno.test("record: commitment discount applied", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute({
    ...BASE,
    ratePerGpuHour: 4.00,
    commitmentTerm: "annual",
    commitmentDiscountPct: 25,
  }, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.monthlyGpuCost, 3.00 * 720 * 8);
  assertEquals(p.costPerGpuHour, 3.00);
  assertEquals(p.costPerGpuHourListRate, 4.00);
});

Deno.test("record: storage + network included", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute({
    ...BASE,
    ratePerGpuHour: 2.00,
    gpuCount: 4,
    storageGb: 2000,
    storageRatePerGbMonth: 0.05,
    networkEgressGbMonth: 1000,
    networkEgressRatePerGb: 0.08,
  }, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.monthlyGpuCost, 5760);
  assertEquals(p.monthlyStorageCost, 100);
  assertEquals(p.monthlyNetworkCost, 80);
  assertEquals(p.monthlyTotalCost, 5940);
  assertEquals(p.costPerGpuHour, 5940 / (720 * 4));
});

Deno.test("record: partial utilization", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute({
    ...BASE,
    hoursPerDay: 8,
    daysPerMonth: 20,
  }, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.effectiveHoursPerMonth, 160);
  assertEquals(p.monthlyGpuCost, 2.49 * 160 * 8);
});

Deno.test("record: break-even with API comparison", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute({
    ...BASE,
    ratePerGpuHour: 2.00,
    gpuCount: 8,
    apiComparisonRatePerMToken: 5.0,
    estimatedTokensPerGpuHour: 100000,
  }, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  const monthly = 2.00 * 720 * 8;
  assertEquals(p.breakEvenTokensPerMonth, monthly / (5.0 / 1_000_000));
});

Deno.test("record: no break-even without API data", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.breakEvenTokensPerMonth, undefined);
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
  assertEquals(projs[0].data.costPerGpuHour, projs[1].data.costPerGpuHour);
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
// update_rate
// =============================================================================

Deno.test("update_rate: changes rate and re-projects", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  await model.methods.update_rate.execute(
    { ratePerGpuHour: 1.99 },
    context as any,
  );
  const projs = findAll(getWrittenResources(), "projection");
  assertEquals(projs[projs.length - 1].data.costPerGpuHour, 1.99);
  const scens = findAll(getWrittenResources(), "scenario");
  assertEquals(scens[scens.length - 1].data.ratePerGpuHour, 1.99);
});

Deno.test("update_rate: preserves other fields", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(
    { ...BASE, storageGb: 500 },
    context as any,
  );
  await model.methods.update_rate.execute(
    { ratePerGpuHour: 1.50 },
    context as any,
  );
  const scens = findAll(getWrittenResources(), "scenario");
  const last = scens[scens.length - 1].data;
  assertEquals(last.storageGb, 500);
  assertEquals(last.gpuCount, 8);
  assertEquals(last.provider, "coreweave");
});

Deno.test("update_rate: throws without scenario", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      model.methods.update_rate.execute(
        { ratePerGpuHour: 1.0 },
        context as any,
      ),
    Error,
    "No scenario recorded",
  );
});

// =============================================================================
// Schema validation
// =============================================================================

Deno.test("schema: rejects hoursPerDay=0", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({ ...BASE, hoursPerDay: 0 })
      .success,
    false,
  );
});

Deno.test("schema: rejects ratePerGpuHour=0", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({ ...BASE, ratePerGpuHour: 0 })
      .success,
    false,
  );
});

Deno.test("schema: rejects commitmentDiscountPct>100", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({
      ...BASE,
      commitmentDiscountPct: 101,
    }).success,
    false,
  );
});

Deno.test("schema: all commitment terms valid", () => {
  for (
    const t of ["none", "monthly", "3-month", "6-month", "annual", "other"]
  ) {
    assertEquals(
      model.methods.record.arguments.safeParse({ ...BASE, commitmentTerm: t })
        .success,
      true,
      `${t} should be valid`,
    );
  }
});
