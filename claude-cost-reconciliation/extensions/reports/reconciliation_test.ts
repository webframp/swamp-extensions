/**
 * Unit tests for the @webframp/claude-cost-reconciliation workflow-scope
 * report. Covers the ten cases enumerated in the extension's DESIGN.md §11,
 * driving `report.execute` with a synthetic workflow context (seeded
 * `dataArtifacts`, `stepExecutions`, and run `inputs`).
 *
 * SPDX-License-Identifier: Apache-2.0
 */
// deno-lint-ignore-file no-explicit-any

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createReportTestContext } from "@swamp-club/swamp-testing";
import { report } from "./reconciliation.ts";

const AWS_TYPE = "@webframp/aws/cost-explorer";
const ANTHROPIC_TYPE = "@webframp/anthropic/analytics";
const AWS_ID = "aws-model-id";
const ANTHROPIC_ID = "anthropic-model-id";

/** Synthetic happy-path AWS resource (fabricated figures, not real billing). */
function awsOk(overrides: Record<string, unknown> = {}) {
  return {
    service: "Claude Enterprise",
    start: "2026-09-01",
    end: "2026-10-01",
    granularity: "MONTHLY",
    groups: [
      { key: "MP:usage_fee-Units", amount: 12000, unit: "USD" },
      { key: "MP:c4e_usage_based_seat_day-Units", amount: 0, unit: "USD" },
    ],
    totalCost: 12000,
    truncated: false,
    fetchedAt: "2026-10-07T13:00:55.335Z",
    ...overrides,
  };
}

/** Synthetic happy-path Anthropic resource (fabricated figures). */
function anthroOk(overrides: Record<string, unknown> = {}) {
  return {
    startDate: "2026-09-01",
    endDate: "2026-10-01",
    totalPaidUsd: 12008,
    totalListUsd: 12008,
    totalDiscountUsd: 0,
    unattributedUsd: 0,
    collected: true,
    reconciliationChecked: true,
    truncated: false,
    rangeExceedsWatermark: false,
    dataRefreshedAt: "2026-10-07T13:01:04.954Z",
    ...overrides,
  };
}

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/** A valid-enough DataHandle for a resource of the given name. */
function handle(name: string) {
  return {
    name,
    specName: "resource",
    kind: "resource" as const,
    dataId: `${name}-id`,
    version: 1,
    size: 1,
    tags: {},
    metadata: {
      contentType: "application/json",
      lifetime: "1h" as any,
      garbageCollection: 10 as any,
      streaming: false,
      tags: {},
      ownerDefinition: { ownerType: "workflow-step", ownerRef: "x" } as any,
    },
  };
}

/** A succeeded step execution for one side. */
function step(opts: {
  modelType: string;
  modelId: string;
  methodName: string;
  dataName?: string;
  status?: "succeeded" | "failed" | "skipped";
}) {
  const dataHandles = opts.dataName ? [handle(opts.dataName)] : [];
  return {
    jobName: "reconcile",
    stepName: opts.methodName,
    taskType: "model_method",
    modelName: opts.modelId,
    modelType: opts.modelType,
    methodName: opts.methodName,
    status: opts.status ?? "succeeded",
    dataHandles,
    methodArgs: {},
    modelId: opts.modelId,
    globalArgs: {},
  };
}

/** A stored data artifact the fake repository can resolve for a step handle. */
function artifact(
  modelType: string,
  modelId: string,
  name: string,
  body: unknown,
) {
  return {
    modelType,
    modelId,
    data: {
      name,
      kind: "resource" as const,
      dataId: `${name}-id`,
      version: 1,
      size: 1,
      contentType: "application/json",
    },
    content: encode(body),
  };
}

/**
 * Build a workflow report context for both sides. Pass `aws`/`anthro` bodies
 * (or null to omit the artifact entirely), and optional per-side step options.
 */
function ctxFor(opts: {
  inputs?: Record<string, unknown>;
  aws?: unknown | null;
  anthro?: unknown | null;
  awsStatus?: "succeeded" | "failed" | "skipped";
  anthroStatus?: "succeeded" | "failed" | "skipped";
  awsHasHandle?: boolean;
  anthroHasHandle?: boolean;
}) {
  const awsName = "aws-window";
  const anthroName = "anthro-window";
  const dataArtifacts = [];
  if (opts.aws !== null && opts.aws !== undefined) {
    dataArtifacts.push(artifact(AWS_TYPE, AWS_ID, awsName, opts.aws));
  }
  if (opts.anthro !== null && opts.anthro !== undefined) {
    dataArtifacts.push(
      artifact(ANTHROPIC_TYPE, ANTHROPIC_ID, anthroName, opts.anthro),
    );
  }
  const stepExecutions = [
    step({
      modelType: AWS_TYPE,
      modelId: AWS_ID,
      methodName: "get_cost_for_period",
      dataName: (opts.awsHasHandle ?? true) ? awsName : undefined,
      status: opts.awsStatus,
    }),
    step({
      modelType: ANTHROPIC_TYPE,
      modelId: ANTHROPIC_ID,
      methodName: "collect_cost_by_model",
      dataName: (opts.anthroHasHandle ?? true) ? anthroName : undefined,
      status: opts.anthroStatus,
    }),
  ];
  const { context } = createReportTestContext({
    scope: "workflow",
    workflowName: "claude-cost-reconciliation",
    inputs: { month: "2026-09", ...(opts.inputs ?? {}) },
    stepExecutions: stepExecutions as any,
    dataArtifacts: dataArtifacts as any,
  });
  return context;
}

// 1. Happy path (synthetic figures) -> MATCH / FINAL, within tolerance.
Deno.test("1: happy path -> MATCH / FINAL", async () => {
  const context = ctxFor({ aws: awsOk(), anthro: anthroOk() });
  const { json } = await report.execute(context);
  const r = (json as any).reconciliation;
  assertEquals(r.verdict, "MATCH");
  assertEquals(r.finality, "FINAL");
  // AWS 12000 vs Anthropic 12008: delta -8.00, pct -0.067% (sub-percent).
  assertEquals(r.deltaUsd, -8);
  assertEquals(r.deltaPct, -0.067);
  assertEquals((json as any).degraded, false);
});

// 2. Delta beyond tolerance -> MISMATCH.
Deno.test("2: delta beyond tolerance -> MISMATCH", async () => {
  // AWS 14000 vs Anthropic 12008: delta ~1992 (16.6%), beyond $50 and 0.5%.
  const context = ctxFor({
    aws: awsOk({ totalCost: 14000, groups: [] }),
    anthro: anthroOk(),
  });
  const { json } = await report.execute(context);
  const r = (json as any).reconciliation;
  assertEquals(r.verdict, "MISMATCH");
  assertEquals(r.finality, "FINAL");
});

// 3. rangeExceedsWatermark=true -> verdict computed but PROVISIONAL.
Deno.test("3: rangeExceedsWatermark -> PROVISIONAL (verdict still computed)", async () => {
  const context = ctxFor({
    aws: awsOk(),
    anthro: anthroOk({ rangeExceedsWatermark: true }),
  });
  const { json } = await report.execute(context);
  const r = (json as any).reconciliation;
  assertEquals(r.verdict, "MATCH");
  assertEquals(r.finality, "PROVISIONAL");
});

// 4. reconciliationChecked=false -> UNVERIFIABLE.
Deno.test("4: reconciliationChecked=false -> UNVERIFIABLE", async () => {
  const context = ctxFor({
    aws: awsOk(),
    anthro: anthroOk({ reconciliationChecked: false }),
  });
  const { json } = await report.execute(context);
  assertEquals((json as any).reconciliation.verdict, "UNVERIFIABLE");
  assertEquals((json as any).degraded, true);
});

// 5. costForPeriod.truncated=true -> UNVERIFIABLE.
Deno.test("5: AWS truncated=true -> UNVERIFIABLE", async () => {
  const context = ctxFor({
    aws: awsOk({ truncated: true }),
    anthro: anthroOk(),
  });
  const { json } = await report.execute(context);
  assertEquals((json as any).reconciliation.verdict, "UNVERIFIABLE");
  assertEquals((json as any).degraded, true);
});

// 6. collected=false -> UNVERIFIABLE.
Deno.test("6: collected=false -> UNVERIFIABLE", async () => {
  const context = ctxFor({
    aws: awsOk(),
    anthro: anthroOk({ collected: false }),
  });
  const { json } = await report.execute(context);
  assertEquals((json as any).reconciliation.verdict, "UNVERIFIABLE");
  assertEquals((json as any).degraded, true);
});

// 7. absent AWS handle -> degraded + UNVERIFIABLE.
Deno.test("7: absent AWS data -> degraded + UNVERIFIABLE", async () => {
  const context = ctxFor({
    aws: null, // no artifact seeded; getContent returns null
    anthro: anthroOk(),
  });
  const { json } = await report.execute(context);
  assertEquals((json as any).reconciliation.verdict, "UNVERIFIABLE");
  assertEquals((json as any).degraded, true);
});

// 8. anthroPaid==0 div-by-zero guard.
Deno.test("8: anthroPaid==0 guards div-by-zero", async () => {
  // Both zero -> trivial MATCH with a note.
  const bothZero = ctxFor({
    aws: awsOk({ totalCost: 0, groups: [] }),
    anthro: anthroOk({ totalPaidUsd: 0, totalListUsd: 0 }),
  });
  const r1 = (await report.execute(bothZero)).json as any;
  assertEquals(r1.reconciliation.verdict, "MATCH");
  assertEquals(r1.reconciliation.deltaPct, 0);
  assertStringIncludes(JSON.stringify(r1.notes), "trivial match");

  // AWS billed but Anthropic zero -> UNVERIFIABLE, no NaN/Infinity.
  const awsOnly = ctxFor({
    aws: awsOk(),
    anthro: anthroOk({ totalPaidUsd: 0 }),
  });
  const r2 = (await report.execute(awsOnly)).json as any;
  assertEquals(r2.reconciliation.verdict, "UNVERIFIABLE");
  assertEquals(r2.reconciliation.deltaPct, null);
});

// 9. tolerance OR-logic: large-value sub-percent passes on %, small-value
//    passes on $ floor.
Deno.test("9: tolerance OR-logic (percent floor and dollar floor)", async () => {
  // Large invoice: delta $200 on $1,000,000 = 0.02% -> passes on PERCENT
  // (exceeds the $50 floor, so AND-logic would wrongly fail it).
  const large = ctxFor({
    inputs: { toleranceUsd: 50, tolerancePct: 0.5 },
    aws: awsOk({ totalCost: 1000200, groups: [] }),
    anthro: anthroOk({ totalPaidUsd: 1000000, totalListUsd: 1000000 }),
  });
  const rl = (await report.execute(large)).json as any;
  assertEquals(rl.reconciliation.verdict, "MATCH");

  // Small invoice: delta $5 on $100 = 5% -> passes on the DOLLAR floor
  // (exceeds the 0.5% floor, so AND-logic would wrongly fail it).
  const small = ctxFor({
    inputs: { toleranceUsd: 50, tolerancePct: 0.5 },
    aws: awsOk({ totalCost: 105, groups: [] }),
    anthro: anthroOk({ totalPaidUsd: 100, totalListUsd: 100 }),
  });
  const rs = (await report.execute(small)).json as any;
  assertEquals(rs.reconciliation.verdict, "MATCH");
});

// 10. markdown contains the headline verdict + both always-on footnotes.
Deno.test("10: markdown has headline verdict + footnotes", async () => {
  const context = ctxFor({ aws: awsOk(), anthro: anthroOk() });
  const { markdown } = await report.execute(context);
  assertStringIncludes(markdown, "MATCH");
  assertStringIncludes(markdown, "(FINAL)");
  assertStringIncludes(markdown, "Bedrock");
  assertStringIncludes(markdown, "cannot be split by model");
});

// Bonus: DR-5 window disagreement -> UNVERIFIABLE (guards a silent miscompare).
Deno.test("DR-5: disagreeing windows -> UNVERIFIABLE", async () => {
  const context = ctxFor({
    aws: awsOk({ start: "2026-09-01", end: "2026-10-01" }),
    anthro: anthroOk({ startDate: "2026-08-01", endDate: "2026-09-01" }),
  });
  const { json } = await report.execute(context);
  assertEquals((json as any).reconciliation.verdict, "UNVERIFIABLE");
  assertStringIncludes(JSON.stringify((json as any).notes), "windows disagree");
});

// Adversarial #1/#2: tolerance compares RAW values, not rounded ones. A true
// pct of 0.5004% (just over the 0.5% tolerance) must be MISMATCH even though it
// rounds to 0.500 for display.
Deno.test("adversarial: boundary pct just over tolerance -> MISMATCH (no round-to-match)", async () => {
  const base = 100000;
  // delta chosen so pct = 0.5004% exactly: delta = base * 0.005004.
  const delta = base * 0.005004; // 500.4
  const context = ctxFor({
    inputs: { toleranceUsd: 50, tolerancePct: 0.5 },
    aws: awsOk({ totalCost: base + delta, groups: [] }),
    anthro: anthroOk({ totalPaidUsd: base, totalListUsd: base }),
  });
  const { json } = await report.execute(context);
  const r = (json as any).reconciliation;
  // Displayed pct rounds to 0.5, but the verdict uses the raw 0.5004 -> MISMATCH.
  assertEquals(r.deltaPct, 0.5);
  assertEquals(r.verdict, "MISMATCH");
});

// Adversarial companion: a true pct exactly at tolerance (0.5%) is a MATCH
// (<=), and a value just under stays MATCH — the boundary is inclusive.
Deno.test("adversarial: pct exactly at tolerance -> MATCH (inclusive)", async () => {
  const base = 100000;
  const delta = base * 0.005; // exactly 0.5%
  const context = ctxFor({
    inputs: { toleranceUsd: 50, tolerancePct: 0.5 },
    aws: awsOk({ totalCost: base + delta, groups: [] }),
    anthro: anthroOk({ totalPaidUsd: base, totalListUsd: base }),
  });
  const { json } = await report.execute(context);
  assertEquals((json as any).reconciliation.verdict, "MATCH");
});
