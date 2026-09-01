// AWS Kiro Usage Report Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { report } from "./kiro_usage_report.ts";

type Ctx = Parameters<typeof report.execute>[0];

function makeScanResults() {
  return {
    scannedAt: "2026-09-01T00:00:00Z",
    billingPeriod: "2026-08-01",
    currency: "USD",
    resolvedIdentities: true,
    users: [
      {
        userId: "u1",
        displayName: "Lang, Samuel",
        email: "slang@example.org",
        username: "SLang",
        resolved: true,
        plan: "Power",
        seatMonths: 1,
        seatCostListUsd: 200,
        seatCostNetUsd: 172,
        credits: 10000,
        overageUsd: 0,
      },
      {
        userId: "u2",
        displayName: "",
        email: "",
        username: "",
        resolved: false,
        plan: "Pro",
        seatMonths: 1,
        seatCostListUsd: 20,
        seatCostNetUsd: 17.2,
        credits: 5,
        overageUsd: 0,
      },
    ],
    tiers: [
      {
        plan: "Power",
        users: 1,
        seatCostListUsd: 200,
        seatCostNetUsd: 172,
        credits: 10000,
      },
      {
        plan: "Pro",
        users: 1,
        seatCostListUsd: 20,
        seatCostNetUsd: 17.2,
        credits: 5,
      },
    ],
    discount: { grossCostUsd: 220, edpDiscountUsd: -30.8, netCostUsd: 189.2 },
    totals: {
      userCount: 2,
      grossCostUsd: 220,
      edpDiscountUsd: -30.8,
      netCostUsd: 189.2,
      creditsConsumed: 10005,
      overageUsd: 0,
    },
  };
}

function makeContext(
  overrides: Partial<Record<string, unknown>> = {},
  resource: unknown = makeScanResults(),
): Ctx {
  const bytes = resource === null
    ? null
    : new TextEncoder().encode(JSON.stringify(resource));
  return {
    modelType: "@webframp/aws/kiro-usage",
    modelId: "kiro-usage",
    definition: { name: "kiro-usage" },
    methodName: "scan",
    methodArgs: {},
    executionStatus: "success",
    dataHandles: [{ name: "scan_results-2026-08-01", kind: "resource" }],
    dataRepository: {
      getContent: () => Promise.resolve(bytes),
    },
    logger: { info: () => {}, warn: () => {} },
    ...overrides,
  } as unknown as Ctx;
}

Deno.test("report metadata is correct", () => {
  assertEquals(report.name, "@webframp/aws/kiro-usage-report");
  assertEquals(report.scope, "method");
});

Deno.test("report skips non-kiro-usage models", async () => {
  const out = await report.execute(
    makeContext({ modelType: "@webframp/aws/bedrock-usage" }),
  );
  assertEquals(out.json.skipped, true);
});

Deno.test("report skips unsupported methods", async () => {
  const out = await report.execute(makeContext({ methodName: "status" }));
  assertEquals(out.json.skipped, true);
});

Deno.test("report degrades gracefully when resource missing", async () => {
  const out = await report.execute(makeContext({}, null));
  assertEquals(out.json.degraded, true);
  assertStringIncludes(out.markdown, "No scan_results resource");
});

Deno.test("report degrades on parseable-but-incomplete resource", async () => {
  // Valid JSON, but missing totals/users/tiers/discount. Must not throw.
  const out = await report.execute(
    makeContext({}, { billingPeriod: "2026-08-01" }),
  );
  assertEquals(out.json.degraded, true);
});

Deno.test("report renders reconciliation, tiers, and per-user tables", async () => {
  const out = await report.execute(makeContext());
  assertEquals(out.json.degraded, false);
  assertStringIncludes(out.markdown, "# AWS Kiro Usage Report");
  assertStringIncludes(out.markdown, "2026-08-01");
  // Reconciliation figures
  assertStringIncludes(out.markdown, "EDP discount");
  assertStringIncludes(out.markdown, "-$30.80");
  assertStringIncludes(out.markdown, "$189.20");
  // Tier + per-user
  assertStringIncludes(out.markdown, "Lang, Samuel");
  assertStringIncludes(out.markdown, "10,000");
  // Unresolved user falls back to id and em-dash email
  assertStringIncludes(out.markdown, "u2");
  // Highlights call out the top consumer
  assertStringIncludes(out.markdown, "Top consumer");
});

Deno.test("report json payload carries structured totals", async () => {
  const out = await report.execute(makeContext());
  const json = out.json as {
    totals: { creditsConsumed: number };
    discount: { netCostUsd: number };
    billingPeriod: string;
  };
  assertEquals(json.billingPeriod, "2026-08-01");
  assertEquals(json.totals.creditsConsumed, 10005);
  assertEquals(json.discount.netCostUsd, 189.2);
});

Deno.test("money formatting handles negatives", async () => {
  const out = await report.execute(makeContext());
  assertMatch(out.markdown, /-\$30\.80/);
});

Deno.test("non-USD amounts render with the currency code, not a bare number", async () => {
  const eur = { ...makeScanResults(), currency: "EUR" };
  const out = await report.execute(makeContext({}, eur));
  // Net 189.20 should appear suffixed with the code, and the discount as -30.80 EUR.
  assertStringIncludes(out.markdown, "189.20 EUR");
  assertStringIncludes(out.markdown, "-30.80 EUR");
});
