// GPU Cloud Cost Projection Model Tests
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import {
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./gpu_cloud.ts";

function makeContext() {
  return createModelTestContext({
    globalArgs: {},
    definition: { id: "test-id", name: "test-cloud", version: 1, tags: {} },
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
  provider: "aws",
  region: "us-east-1",
  instanceType: "p5.48xlarge",
  gpuCount: 8,
  gpuModel: "H100",
  capacityModel: "on-demand",
  instanceRatePerHour: 98.32,
  hoursPerDay: 24,
  daysPerMonth: 30,
  replicas: 1,
  storageGb: 0,
  storageRatePerGbMonth: 0,
  dataTransferGbMonth: 0,
  dataTransferRatePerGb: 0,
  managementFeePerMonth: 0,
};

// =============================================================================
// Model Structure
// =============================================================================

Deno.test("model type string", () => {
  assertEquals(model.type, "@webframp/cost-projection/gpu-cloud");
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

Deno.test("record: base case costPerGpuHour", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.costPerGpuHour, 98.32 / 8);
  assertEquals(p.costPerInstanceHour, 98.32);
  assertEquals(p.monthlyTotalCost, 98.32 * 720);
  assertEquals(p.annualTotalCost, 98.32 * 720 * 12);
  assertEquals(p.effectiveHoursPerMonth, 720);
  assertEquals(p.totalGpuCount, 8);
});

Deno.test("record: writes scenario and projection", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  const r = getWrittenResources();
  assertEquals(r.length, 2);
  assertEquals(r[0].specName, "scenario");
  assertEquals(r[1].specName, "projection");
});

Deno.test("record: storage + transfer + mgmt in total", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute({
    ...BASE,
    instanceRatePerHour: 100,
    storageGb: 1000,
    storageRatePerGbMonth: 0.10,
    dataTransferGbMonth: 500,
    dataTransferRatePerGb: 0.09,
    managementFeePerMonth: 200,
  }, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.monthlyComputeCost, 72000);
  assertEquals(p.monthlyStorageCost, 100);
  assertEquals(p.monthlyTransferCost, 45);
  assertEquals(p.monthlyManagementCost, 200);
  assertEquals(p.monthlyTotalCost, 72345);
  assertEquals(p.costPerGpuHour, 72345 / 720 / 8);
});

Deno.test("record: replicas scale compute + storage, not transfer/mgmt", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute({
    ...BASE,
    instanceRatePerHour: 100,
    replicas: 2,
    storageGb: 1000,
    storageRatePerGbMonth: 0.10,
    dataTransferGbMonth: 100,
    dataTransferRatePerGb: 0.10,
    managementFeePerMonth: 50,
  }, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.monthlyComputeCost, 144000);
  assertEquals(p.monthlyStorageCost, 200);
  assertEquals(p.monthlyTransferCost, 10);
  assertEquals(p.monthlyManagementCost, 50);
  assertEquals(p.totalGpuCount, 16);
  assertEquals(p.costPerInstanceHour, 144260 / (720 * 2));
  assertEquals(p.costPerGpuHour, 144260 / (720 * 2) / 8);
});

Deno.test("record: partial day utilization", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute({
    ...BASE,
    instanceRatePerHour: 100,
    hoursPerDay: 12,
    daysPerMonth: 22,
  }, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.effectiveHoursPerMonth, 264);
  assertEquals(p.monthlyComputeCost, 100 * 264);
});

Deno.test("record: break-even with API comparison", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute({
    ...BASE,
    instanceRatePerHour: 100,
    apiComparisonRatePerMToken: 3.0,
    estimatedTokensPerGpuHour: 50000,
  }, context as any);
  const p = findResource(getWrittenResources(), "projection").data;
  assertEquals(p.breakEvenTokensPerMonth, 72000 / (3.0 / 1_000_000));
  assertEquals(
    p.breakEvenRequestsPerMonth,
    Math.ceil(p.breakEvenTokensPerMonth / 4000),
  );
});

Deno.test("record: no break-even without API comparison", async () => {
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
    { instanceRatePerHour: 75 },
    context as any,
  );
  const projs = findAll(getWrittenResources(), "projection");
  assertEquals(projs[projs.length - 1].data.costPerGpuHour, 75 / 8);
  const scens = findAll(getWrittenResources(), "scenario");
  assertEquals(scens[scens.length - 1].data.instanceRatePerHour, 75);
});

Deno.test("update_rate: sets quotedAt", async () => {
  const { context, getWrittenResources } = makeContext();
  await model.methods.record.execute(BASE, context as any);
  await model.methods.update_rate.execute(
    { instanceRatePerHour: 75, quotedAt: "2026-08-01" },
    context as any,
  );
  const scens = findAll(getWrittenResources(), "scenario");
  assertEquals(scens[scens.length - 1].data.quotedAt, "2026-08-01");
});

Deno.test("update_rate: throws without scenario", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      model.methods.update_rate.execute(
        { instanceRatePerHour: 50 },
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

Deno.test("schema: rejects daysPerMonth=0", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({ ...BASE, daysPerMonth: 0 })
      .success,
    false,
  );
});

Deno.test("schema: rejects gpuCount=0", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({ ...BASE, gpuCount: 0 }).success,
    false,
  );
});

Deno.test("schema: rejects instanceRatePerHour=0", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({
      ...BASE,
      instanceRatePerHour: 0,
    }).success,
    false,
  );
});

Deno.test("schema: rejects negative rate", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({
      ...BASE,
      instanceRatePerHour: -1,
    }).success,
    false,
  );
});

Deno.test("schema: defaults applied", () => {
  const r = model.methods.record.arguments.parse({
    name: "x",
    provider: "aws",
    region: "x",
    instanceType: "x",
    gpuCount: 1,
    gpuModel: "x",
    capacityModel: "on-demand",
    instanceRatePerHour: 1,
  });
  assertEquals(r.hoursPerDay, 24);
  assertEquals(r.daysPerMonth, 30);
  assertEquals(r.replicas, 1);
  assertEquals(r.currency, "USD");
});

Deno.test("schema: all capacity models valid", () => {
  for (
    const cm of [
      "on-demand",
      "reserved-1yr",
      "reserved-3yr",
      "savings-plan",
      "flexible-training-plan",
      "capacity-block",
      "committed-use-1yr",
      "committed-use-3yr",
      "other",
    ]
  ) {
    assertEquals(
      model.methods.record.arguments.safeParse({ ...BASE, capacityModel: cm })
        .success,
      true,
      `${cm} should be valid`,
    );
  }
});

Deno.test("schema: rejects invalid capacity model", () => {
  assertEquals(
    model.methods.record.arguments.safeParse({
      ...BASE,
      capacityModel: "bogus",
    }).success,
    false,
  );
});
