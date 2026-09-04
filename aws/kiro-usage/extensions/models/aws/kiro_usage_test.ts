// AWS Kiro Usage Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertMatch,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { AthenaClient } from "npm:@aws-sdk/client-athena@3.1126.0";
import { IdentitystoreClient } from "npm:@aws-sdk/client-identitystore@3.1126.0";
import {
  buildDiscountQuery,
  buildPerUserQuery,
  mergeUsers,
  model,
  previousMonthStart,
  rowsToRecords,
  tierWeight,
  toNumber,
} from "./kiro_usage.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

/**
 * Override AthenaClient.prototype.send. The handler receives the command's
 * constructor name and must return the appropriate mock response. StartQuery
 * returns a fixed id; GetQueryExecution returns SUCCEEDED; GetQueryResults
 * returns rows keyed by which SQL was submitted (per-user vs discount).
 */
function mockAthena(
  perUserRows: string[][],
  discountRows: string[][],
): () => void {
  const original = AthenaClient.prototype.send;
  let lastSql = "";
  // deno-lint-ignore no-explicit-any
  AthenaClient.prototype.send = function (command: any) {
    const name = command?.constructor?.name || "";
    if (name === "StartQueryExecutionCommand") {
      lastSql = command.input?.QueryString ?? "";
      const isDiscount = lastSql.includes("EdpDiscount");
      return Promise.resolve({
        QueryExecutionId: isDiscount ? "qid-discount" : "qid-user",
      });
    }
    if (name === "GetQueryExecutionCommand") {
      return Promise.resolve({
        QueryExecution: { Status: { State: "SUCCEEDED" } },
      });
    }
    if (name === "GetQueryResultsCommand") {
      const id = command.input?.QueryExecutionId ?? "";
      const rows = id === "qid-discount" ? discountRows : perUserRows;
      return Promise.resolve({
        ResultSet: {
          Rows: rows.map((cells) => ({
            Data: cells.map((v) => ({ VarCharValue: v })),
          })),
        },
        NextToken: undefined,
      });
    }
    return Promise.resolve({});
  } as typeof original;
  return () => {
    AthenaClient.prototype.send = original;
  };
}

/** Override IdentitystoreClient.prototype.send with a fixed user record. */
function mockIdentityStore(): () => void {
  const original = IdentitystoreClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  IdentitystoreClient.prototype.send = function (command: any) {
    const userId = command.input?.UserId ?? "unknown";
    return Promise.resolve({
      UserId: userId,
      UserName: `user-${userId}@example.org`,
      DisplayName: `User ${userId}`,
      Name: { GivenName: "Test", FamilyName: "User" },
      Emails: [{ Value: `user-${userId}@example.org`, Primary: true }],
    });
  } as typeof original;
  return () => {
    IdentitystoreClient.prototype.send = original;
  };
}

type ScanCtx = Parameters<typeof model.methods.scan.execute>[1];

const HEADER_USER = [
  "user_id",
  "plan",
  "seat_months",
  "seat_list_cost",
  "credits",
];
const HEADER_DISCOUNT = ["gross", "edp_discount", "currency"];

function baseGlobalArgs(overrides: Record<string, unknown> = {}) {
  return {
    curProfile: "default",
    identityStoreRegion: "us-east-1",
    athenaRegion: "us-east-1",
    athenaDatabase: "awscurdatabase",
    athenaTable: "cur_table",
    athenaWorkgroup: "primary",
    athenaOutputLocation: "s3://results/",
    resolveIdentities: false,
    mergeAccounts: {},
    ...overrides,
  };
}

// =============================================================================
// Structure & Validation
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/kiro-usage");
});

Deno.test("model version matches CalVer pattern", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model defines scan_results resource and scan method", () => {
  assertEquals("scan_results" in model.resources, true);
  assertEquals("scan" in model.methods, true);
});

Deno.test("globalArguments require athenaDatabase/table/output", () => {
  const missing = model.globalArguments.safeParse({});
  assertEquals(missing.success, false);
  const ok = model.globalArguments.safeParse({
    athenaDatabase: "db",
    athenaTable: "t",
    athenaOutputLocation: "s3://x/",
  });
  assertEquals(ok.success, true);
  if (ok.success) {
    assertEquals(ok.data.curProfile, "default");
    assertEquals(ok.data.resolveIdentities, true);
    assertEquals(ok.data.athenaWorkgroup, "primary");
  }
});

Deno.test("scan rejects a malformed month argument", () => {
  const schema = model.methods.scan.arguments;
  assertEquals(schema.safeParse({ month: "2026-8-1" }).success, false);
  assertEquals(schema.safeParse({ month: "2026-08-01" }).success, true);
  assertEquals(schema.safeParse({}).success, true);
});

// =============================================================================
// Pure-helper tests
// =============================================================================

Deno.test("toNumber handles blanks and non-numbers", () => {
  assertEquals(toNumber(""), 0);
  assertEquals(toNumber(undefined), 0);
  assertEquals(toNumber("not-a-number"), 0);
  assertEquals(toNumber("42.5"), 42.5);
});

Deno.test("previousMonthStart returns first of prior month (UTC)", () => {
  assertEquals(
    previousMonthStart(new Date("2026-09-15T00:00:00Z")),
    "2026-08-01",
  );
  // January rolls back to December of the prior year.
  assertEquals(
    previousMonthStart(new Date("2026-01-10T00:00:00Z")),
    "2025-12-01",
  );
});

Deno.test("query builders interpolate a validated table identifier and target the period", () => {
  const q = buildPerUserQuery("cur_table", "2026-08-01");
  assertMatch(q, /FROM cur_table/);
  assertMatch(q, /2026-08-01 00:00:00/);
  const d = buildDiscountQuery("cur", "2026-08-01");
  assertMatch(d, /EdpDiscount/);
  assertMatch(d, /FlatRateSubscription/);
});

Deno.test("schema rejects unsafe Athena identifiers", () => {
  const base = {
    athenaDatabase: "db",
    athenaTable: "t",
    athenaOutputLocation: "s3://x/",
  };
  assertEquals(
    model.globalArguments.safeParse({ ...base, athenaTable: "t'; DROP" })
      .success,
    false,
  );
  assertEquals(
    model.globalArguments.safeParse({ ...base, athenaDatabase: "a b" }).success,
    false,
  );
});

Deno.test("rowsToRecords keys cells by header", () => {
  const recs = rowsToRecords([
    ["a", "b"],
    ["1", "2"],
  ]);
  assertEquals(recs, [{ a: "1", b: "2" }]);
  assertEquals(rowsToRecords([]), []);
});

Deno.test("tierWeight orders Power < ProPlus < Pro < other", () => {
  assertEquals(tierWeight("Power") < tierWeight("ProPlus"), true);
  assertEquals(tierWeight("ProPlus") < tierWeight("Pro"), true);
  assertEquals(tierWeight("Pro") < tierWeight("(no seat)"), true);
});

Deno.test("mergeUsers folds a secondary into its primary (order-independent)", () => {
  const primary = {
    userId: "primary",
    displayName: "P",
    email: "p@example.org",
    username: "P",
    resolved: true,
    plan: "Power",
    seatMonths: 1,
    seatCostListUsd: 200,
    seatCostNetUsd: 172,
    credits: 100,
    overageUsd: 0,
  };
  const secondary = {
    userId: "secondary",
    displayName: "S",
    email: "",
    username: "",
    resolved: false,
    plan: "Power",
    seatMonths: 1,
    seatCostListUsd: 200,
    seatCostNetUsd: 172,
    credits: 50,
    overageUsd: 0,
  };
  const map = { secondary: "primary" };

  // Both row orders must produce identical, correct totals.
  for (const order of [[primary, secondary], [secondary, primary]]) {
    const merged = mergeUsers(order, map);
    assertEquals(merged.length, 1);
    assertEquals(merged[0].userId, "primary");
    assertEquals(merged[0].credits, 150);
    assertEquals(merged[0].seatCostListUsd, 400);
    assertEquals(merged[0].seatCostNetUsd, 344);
    // Primary's own row is authoritative for identity.
    assertEquals(merged[0].displayName, "P");
    assertEquals(merged[0].email, "p@example.org");
    assertEquals(merged[0].plan, "Power");
  }
});

Deno.test("mergeUsers folds two secondaries into one primary without double-count", () => {
  const mk = (id: string, credits: number) => ({
    userId: id,
    displayName: id,
    email: "",
    username: "",
    resolved: false,
    plan: "Pro",
    seatMonths: 1,
    seatCostListUsd: 20,
    seatCostNetUsd: 17.2,
    credits,
    overageUsd: 0,
  });
  const rows = [mk("s1", 30), mk("s2", 40), mk("p", 100)];
  const merged = mergeUsers(rows, { s1: "p", s2: "p" });
  assertEquals(merged.length, 1);
  assertEquals(merged[0].userId, "p");
  assertEquals(merged[0].credits, 170);
  assertEquals(merged[0].seatCostListUsd, 60);
});

Deno.test("mergeUsers handles a target with no row of its own", () => {
  const s = {
    userId: "s1",
    displayName: "S1",
    email: "",
    username: "",
    resolved: false,
    plan: "Pro",
    seatMonths: 1,
    seatCostListUsd: 20,
    seatCostNetUsd: 17.2,
    credits: 25,
    overageUsd: 0,
  };
  // Primary "p" is referenced by the map but has no row in the data.
  const merged = mergeUsers([s], { s1: "p" });
  assertEquals(merged.length, 1);
  assertEquals(merged[0].userId, "p");
  assertEquals(merged[0].credits, 25);
  assertEquals(merged[0].plan, "Pro");
});

// =============================================================================
// Execute-level
// =============================================================================

Deno.test({
  name: "scan reconciles EDP discount and allocates net per user",
  sanitizeResources: false,
  fn: async () => {
    // Two Power users at $200 list; account gross 400, EDP -56 => net 344.
    const perUser = [
      HEADER_USER,
      ["u1", "Power", "1.0", "200", "10000"],
      ["u2", "Power", "1.0", "200", "2000"],
    ];
    const discount = [
      HEADER_DISCOUNT,
      ["400", "-56", "USD"],
    ];
    const restore = mockAthena(perUser, discount);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: baseGlobalArgs(),
        definition: { id: "id", name: "kiro-usage", version: 1, tags: {} },
      });

      const result = await model.methods.scan.execute(
        { month: "2026-08-01" },
        context as unknown as ScanCtx,
      );
      assertExists(result.dataHandles);
      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "scan_results");

      const data = resources[0].data as {
        billingPeriod: string;
        discount: {
          grossCostUsd: number;
          edpDiscountUsd: number;
          netCostUsd: number;
        };
        totals: {
          netCostUsd: number;
          creditsConsumed: number;
          userCount: number;
        };
        users: Array<
          { userId: string; seatCostNetUsd: number; credits: number }
        >;
        resolvedIdentities: boolean;
      };

      assertEquals(data.billingPeriod, "2026-08-01");
      assertEquals(data.discount.grossCostUsd, 400);
      assertEquals(data.discount.edpDiscountUsd, -56);
      assertEquals(data.discount.netCostUsd, 344);
      assertEquals(data.totals.creditsConsumed, 12000);
      assertEquals(data.totals.userCount, 2);
      // net ratio 344/400 = 0.86 -> 200 * 0.86 = 172 per user
      assertEquals(data.users[0].seatCostNetUsd, 172);
      // sorted by credits desc within tier: u1 (10000) first
      assertEquals(data.users[0].userId, "u1");
      assertEquals(data.resolvedIdentities, false);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "scan reconciles summed per-user net to the account net exactly",
  sanitizeResources: false,
  fn: async () => {
    // 3 Pro users at $20 list, gross 60, EDP -8.41 => net 51.59.
    // netRatio = 51.59/60 = 0.859833..., per-user 20*ratio = 17.196 -> 17.20
    // rounded. Summed rounded = 51.60, drifting 0.01 above net; the residual
    // adjustment must bring the sum back to exactly 51.59.
    const perUser = [
      HEADER_USER,
      ["u1", "Pro", "1.0", "20", "300"],
      ["u2", "Pro", "1.0", "20", "200"],
      ["u3", "Pro", "1.0", "20", "100"],
    ];
    const discount = [HEADER_DISCOUNT, ["60", "-8.41", "USD"]];
    const restore = mockAthena(perUser, discount);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: baseGlobalArgs(),
        definition: { id: "id", name: "kiro-usage", version: 1, tags: {} },
      });
      await model.methods.scan.execute(
        { month: "2026-08-01" },
        context as unknown as ScanCtx,
      );
      const data = getWrittenResources()[0].data as {
        discount: { netCostUsd: number };
        users: Array<{ seatCostNetUsd: number }>;
      };
      const summed = Math.round(
        data.users.reduce((s, u) => s + u.seatCostNetUsd, 0) * 100,
      ) / 100;
      assertEquals(summed, data.discount.netCostUsd);
      assertEquals(summed, 51.59);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "scan resolves identities when enabled",
  sanitizeResources: false,
  fn: async () => {
    const perUser = [HEADER_USER, ["abc", "Pro", "1.0", "20", "5"]];
    const discount = [HEADER_DISCOUNT, ["20", "0", "USD"]];
    const restoreAthena = mockAthena(perUser, discount);
    const restoreIds = mockIdentityStore();
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: baseGlobalArgs({
          resolveIdentities: true,
          identityStoreId: "d-1234567890",
        }),
        definition: { id: "id", name: "kiro-usage", version: 1, tags: {} },
      });

      await model.methods.scan.execute(
        { month: "2026-08-01" },
        context as unknown as ScanCtx,
      );
      const data = getWrittenResources()[0].data as {
        resolvedIdentities: boolean;
        users: Array<{ resolved: boolean; email: string; displayName: string }>;
      };
      assertEquals(data.resolvedIdentities, true);
      assertEquals(data.users[0].resolved, true);
      assertEquals(data.users[0].email, "user-abc@example.org");
      assertEquals(data.users[0].displayName, "User abc");
    } finally {
      restoreIds();
      restoreAthena();
    }
  },
});

Deno.test({
  name: "scan falls back to net ratio 1.0 when gross is zero",
  sanitizeResources: false,
  fn: async () => {
    const perUser = [HEADER_USER, ["u1", "Pro", "1.0", "20", "0"]];
    const discount = [HEADER_DISCOUNT, ["0", "0", "USD"]];
    const restore = mockAthena(perUser, discount);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: baseGlobalArgs(),
        definition: { id: "id", name: "kiro-usage", version: 1, tags: {} },
      });
      await model.methods.scan.execute(
        { month: "2026-08-01" },
        context as unknown as ScanCtx,
      );
      const data = getWrittenResources()[0].data as {
        users: Array<{ seatCostNetUsd: number }>;
      };
      assertEquals(data.users[0].seatCostNetUsd, 20);
    } finally {
      restore();
    }
  },
});
