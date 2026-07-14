// Claude Enterprise Analytics Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./analytics.ts";

// ---------------------------------------------------------------------------
// Model Export Structure Tests
// ---------------------------------------------------------------------------

Deno.test("analytics model: has correct type", () => {
  assertEquals(model.type, "@webframp/anthropic/analytics");
});

Deno.test("analytics model: has valid version format", () => {
  const versionPattern = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
  assertEquals(versionPattern.test(model.version), true);
});

Deno.test("analytics model: has globalArguments with analyticsKey", () => {
  assertExists(model.globalArguments);
  const shape = model.globalArguments.shape;
  assertExists(shape.analyticsKey);
});

Deno.test("analytics model: has required resources", () => {
  assertExists(model.resources);
  assertExists(model.resources.snapshot);
  assertExists(model.resources.seats);
  assertExists(model.resources.adoption);
  assertExists(model.resources.cost);
});

Deno.test("analytics model: has required methods", () => {
  assertExists(model.methods);
  assertExists(model.methods.collect_analytics);
});

Deno.test("analytics model: all resources have lifetime and gc", () => {
  for (
    const [name, spec] of Object.entries(model.resources) as [
      string,
      { lifetime: string; garbageCollection: number },
    ][]
  ) {
    assertExists(spec.lifetime, `${name} missing lifetime`);
    assertExists(spec.garbageCollection, `${name} missing garbageCollection`);
  }
});

Deno.test("analytics model: collect_analytics has optional date arguments", () => {
  const args = model.methods.collect_analytics.arguments;
  assertExists(args);
  const shape = args.shape;
  assertExists(shape.startDate);
  assertExists(shape.endDate);
});

// ---------------------------------------------------------------------------
// Mock Anthropic Enterprise Analytics API Server
// ---------------------------------------------------------------------------

const MOCK_SUMMARIES = [
  {
    starting_at: "2026-07-01T00:00:00Z",
    ending_at: "2026-07-02T00:00:00Z",
    assigned_seat_count: 48,
    daily_active_user_count: 20,
    weekly_active_user_count: 30,
    monthly_active_user_count: 38,
    pending_invite_count: 2,
  },
  {
    starting_at: "2026-07-02T00:00:00Z",
    ending_at: "2026-07-03T00:00:00Z",
    assigned_seat_count: 50,
    daily_active_user_count: 28,
    weekly_active_user_count: 35,
    monthly_active_user_count: 40,
    pending_invite_count: 3,
  },
];

const MOCK_USERS = [
  {
    user: { id: "u1", email_address: "a@example.com" },
    chat_metrics: {
      distinct_projects_used_count: 2,
      distinct_skills_used_count: 1,
      distinct_connectors_used_count: 0,
    },
  },
  {
    user: { id: "u2", email_address: "b@example.com" },
    chat_metrics: {
      distinct_projects_used_count: 0,
      distinct_skills_used_count: 0,
      distinct_connectors_used_count: 3,
    },
  },
  {
    user: { id: "u3", email_address: "c@example.com" },
    chat_metrics: { distinct_projects_used_count: 1 },
    cowork_metrics: { distinct_skills_used_count: 5 },
  },
];

const MOCK_COST_BUCKETS = [
  {
    starting_at: "2026-07-01T00:00:00Z",
    ending_at: "2026-07-02T00:00:00Z",
    results: [
      { amount: "41280.000000", currency: "USD", cost_type: "tokens" },
      { amount: "1000.000000", currency: "USD", cost_type: "web_search" },
    ],
  },
];

const MOCK_USER_USAGE = [
  {
    actor: { user_id: "user_1", email: "sescriva@jw.org", name: "Sean" },
    product: "claude_code",
    total_tokens: 5000000,
    output_tokens: 800000,
    uncached_input_tokens: 1200000,
    cache_read_input_tokens: 3000000,
    requests: 120,
  },
  {
    actor: { user_id: "user_1", email: "sescriva@jw.org", name: "Sean" },
    product: "chat",
    total_tokens: 200000,
    output_tokens: 40000,
    uncached_input_tokens: 100000,
    cache_read_input_tokens: 60000,
    requests: 15,
  },
  {
    actor: { user_id: "user_2", email: "b@example.com", name: "Bee" },
    product: "claude_code",
    total_tokens: 1000000,
    output_tokens: 100000,
    uncached_input_tokens: 400000,
    cache_read_input_tokens: 500000,
    requests: 30,
  },
];

// amount/list_amount are USD minor units (cents): 41280 => $412.80.
const MOCK_USER_COST = [
  {
    actor: { user_id: "user_1", email: "sescriva@jw.org", name: "Sean" },
    product: "claude_code",
    amount: "41280.000000",
    list_amount: "51600.000000",
    currency: "USD",
  },
  {
    actor: { user_id: "user_1", email: "sescriva@jw.org", name: "Sean" },
    product: "chat",
    amount: "1000.000000",
    list_amount: "1000.000000",
    currency: "USD",
  },
  {
    actor: { user_id: "user_2", email: "b@example.com", name: "Bee" },
    product: "claude_code",
    amount: "5000.000000",
    list_amount: "6000.000000",
    currency: "USD",
  },
];

type MockOpts = {
  summaries?: unknown[];
  users?: unknown[];
  costBuckets?: unknown[];
  userUsage?: unknown[];
  userCost?: unknown[];
  failPath?: string; // substring of pathname to fail
  failStatus?: number;
  capture?: Record<string, Record<string, string>>;
};

function startMockServer(
  opts?: MockOpts,
): { url: string; server: Deno.HttpServer } {
  const server = Deno.serve({ port: 0, onListen() {} }, (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (opts?.capture) {
      const key = path.split("/").pop() ?? path;
      opts.capture[key] = Object.fromEntries(url.searchParams);
    }
    if (opts?.failPath && path.includes(opts.failPath)) {
      return new Response(
        JSON.stringify({ error: { message: "Forbidden" } }),
        { status: opts.failStatus ?? 500 },
      );
    }
    if (path.endsWith("/analytics/summaries")) {
      return Response.json({
        summaries: opts?.summaries ?? MOCK_SUMMARIES,
        data_refreshed_at: "2026-07-02T12:00:00Z",
      });
    }
    if (path.endsWith("/analytics/users")) {
      return Response.json({
        data: opts?.users ?? MOCK_USERS,
        next_page: null,
      });
    }
    if (path.endsWith("/analytics/cost_report")) {
      return Response.json({
        data: opts?.costBuckets ?? MOCK_COST_BUCKETS,
        has_more: false,
        next_page: null,
        data_refreshed_at: "2026-07-02T12:00:00Z",
      });
    }
    if (path.endsWith("/analytics/user_usage_report")) {
      return Response.json({
        data: opts?.userUsage ?? MOCK_USER_USAGE,
        has_more: false,
        next_page: null,
        data_refreshed_at: "2026-07-14T12:00:00Z",
      });
    }
    if (path.endsWith("/analytics/user_cost_report")) {
      return Response.json({
        data: opts?.userCost ?? MOCK_USER_COST,
        has_more: false,
        next_page: null,
        data_refreshed_at: "2026-07-14T12:00:00Z",
      });
    }
    return new Response("Not found", { status: 404 });
  });
  const addr = server.addr as Deno.NetAddr;
  return { url: `http://localhost:${addr.port}`, server };
}

function installFetchMock(mockUrl: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const reqUrl = typeof input === "string"
      ? input
      : input instanceof Request
      ? input.url
      : input.toString();
    const newUrl = reqUrl.replace("https://api.anthropic.com", mockUrl);
    return originalFetch(newUrl, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function testContext() {
  return createModelTestContext({
    globalArgs: { analyticsKey: "ak-test-key" },
    definition: { id: "test-id", name: "test-analytics", version: 1, tags: {} },
  });
}

type ExecCtx = Parameters<typeof model.methods.collect_analytics.execute>[1];

// ---------------------------------------------------------------------------
// Method Execution Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "analytics: collect_analytics writes snapshot, seats, adoption, cost",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      const result = await model.methods.collect_analytics.execute(
        {},
        context as unknown as ExecCtx,
      );
      assertEquals(result.dataHandles.length, 4);
      const written = getWrittenResources();
      const specNames = written.map((r) => r.specName).sort();
      assertEquals(specNames, ["adoption", "cost", "seats", "snapshot"]);
      // "latest" is reserved by swamp — no resource may use it as an instance.
      assertEquals(written.some((r) => r.name === "latest"), false);
      // Instance names must be unique within a single method run.
      const names = written.map((r) => r.name);
      assertEquals(new Set(names).size, names.length);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: snapshot stores raw summaries with correct count",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      await model.methods.collect_analytics.execute(
        {},
        context as unknown as ExecCtx,
      );
      const snapshot = getWrittenResources().find((r) =>
        r.specName === "snapshot"
      );
      assertExists(snapshot);
      assertEquals(snapshot.name, "recent");
      const data = snapshot.data as {
        summaries: unknown[];
        count: number;
        dataRefreshedAt: string;
      };
      assertEquals(data.count, 2);
      assertEquals(data.dataRefreshedAt, "2026-07-02T12:00:00Z");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: seats resource uses the latest summarized day",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      await model.methods.collect_analytics.execute(
        {},
        context as unknown as ExecCtx,
      );
      const seats = getWrittenResources().find((r) => r.specName === "seats");
      assertExists(seats);
      assertEquals(seats.name, "current");
      const data = seats.data as {
        total: number;
        active: number;
        pending_invites: number;
        dau: number;
        wau: number;
        mau: number;
      };
      // 2026-07-02 row is the latest → 50/28/35/40, pending 3
      assertEquals(data.total, 50);
      assertEquals(data.active, 28);
      assertEquals(data.pending_invites, 3);
      assertEquals(data.dau, 28);
      assertEquals(data.wau, 35);
      assertEquals(data.mau, 40);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: adoption aggregates adopter counts across users",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      await model.methods.collect_analytics.execute(
        {},
        context as unknown as ExecCtx,
      );
      const adoption = getWrittenResources().find((r) =>
        r.specName === "adoption"
      );
      assertExists(adoption);
      assertEquals(adoption.name, "adoption");
      const data = adoption.data as {
        projects: number;
        skills: number;
        connectors: number;
      };
      // projects: u1,u3 → 2; skills: u1 (chat), u3 (cowork) → 2; connectors: u2 → 1
      assertEquals(data.projects, 2);
      assertEquals(data.skills, 2);
      assertEquals(data.connectors, 1);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: cost sums amounts across results by cost_type",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      await model.methods.collect_analytics.execute(
        {},
        context as unknown as ExecCtx,
      );
      const cost = getWrittenResources().find((r) => r.specName === "cost");
      assertExists(cost);
      assertEquals(cost.name, "window");
      const data = cost.data as {
        total_cents: number;
        total_usd: number;
        currency: string;
        by_cost_type: Record<string, number>;
      };
      assertEquals(data.total_cents, 42280);
      assertEquals(data.total_usd, 422.8);
      assertEquals(data.currency, "USD");
      assertEquals(data.by_cost_type.tokens, 41280);
      assertEquals(data.by_cost_type.web_search, 1000);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: empty summaries yields null seats, count 0",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer({ summaries: [] });
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      await model.methods.collect_analytics.execute(
        {},
        context as unknown as ExecCtx,
      );
      const resources = getWrittenResources();
      const snapshot = resources.find((r) => r.specName === "snapshot");
      assertExists(snapshot);
      assertEquals((snapshot.data as { count: number }).count, 0);
      const seats = resources.find((r) => r.specName === "seats");
      assertExists(seats);
      assertEquals((seats.data as { total: number | null }).total, null);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// ---------------------------------------------------------------------------
// Argument & Resilience Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "analytics: maps date args to per-endpoint params",
  sanitizeResources: false,
  fn: async () => {
    const capture: Record<string, Record<string, string>> = {};
    const { url, server } = startMockServer({ capture });
    const uninstall = installFetchMock(url);
    try {
      const { context } = testContext();
      await model.methods.collect_analytics.execute(
        { startDate: "2026-06-01", endDate: "2026-07-01" },
        context as unknown as ExecCtx,
      );
      // summaries + users use date-only params
      assertEquals(capture["summaries"]["starting_date"], "2026-06-01");
      assertEquals(capture["summaries"]["ending_date"], "2026-07-01");
      // cost_report uses timestamps and daily buckets
      assertEquals(
        capture["cost_report"]["starting_at"],
        "2026-06-01T00:00:00Z",
      );
      assertEquals(capture["cost_report"]["ending_at"], "2026-07-01T00:00:00Z");
      assertEquals(capture["cost_report"]["bucket_width"], "1d");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: adoption is best-effort — /users failure does not fail run",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer({ failPath: "/analytics/users" });
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      const result = await model.methods.collect_analytics.execute(
        {},
        context as unknown as ExecCtx,
      );
      assertEquals(result.dataHandles.length, 4);
      const adoption = getWrittenResources().find((r) =>
        r.specName === "adoption"
      );
      assertExists(adoption);
      const adoptionData = adoption.data as {
        projects: number | null;
        collected: boolean;
      };
      assertEquals(adoptionData.projects, null);
      // failure must be distinguishable from a legitimately empty org
      assertEquals(adoptionData.collected, false);
      // core seats still populated
      const seats = getWrittenResources().find((r) => r.specName === "seats");
      assertEquals((seats?.data as { total: number }).total, 50);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: cost is best-effort — /cost_report failure zeroes cost",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer({
      failPath: "/analytics/cost_report",
    });
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      const result = await model.methods.collect_analytics.execute(
        {},
        context as unknown as ExecCtx,
      );
      assertEquals(result.dataHandles.length, 4);
      const cost = getWrittenResources().find((r) => r.specName === "cost");
      assertExists(cost);
      const costData = cost.data as { total_cents: number; collected: boolean };
      assertEquals(costData.total_cents, 0);
      // zeroed cost from a failure must be distinguishable from seat-based $0
      assertEquals(costData.collected, false);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: /users pagination concatenates pages",
  sanitizeResources: false,
  fn: async () => {
    // Page 1 (no cursor) → one project-adopter + next_page; page 2 → one
    // skill-adopter + next_page:null.
    const server = Deno.serve({ port: 0, onListen() {} }, (req: Request) => {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path.endsWith("/analytics/summaries")) {
        return Response.json({ summaries: MOCK_SUMMARIES });
      }
      if (path.endsWith("/analytics/users")) {
        if (!url.searchParams.get("page")) {
          return Response.json({
            data: [{
              user: { id: "p1" },
              chat_metrics: { distinct_projects_used_count: 1 },
            }],
            next_page: "PAGE2",
          });
        }
        return Response.json({
          data: [{
            user: { id: "p2" },
            chat_metrics: { distinct_skills_used_count: 1 },
          }],
          next_page: null,
        });
      }
      if (path.endsWith("/analytics/cost_report")) {
        return Response.json({ data: [], has_more: false, next_page: null });
      }
      return new Response("Not found", { status: 404 });
    });
    const addr = server.addr as Deno.NetAddr;
    const uninstall = installFetchMock(`http://localhost:${addr.port}`);
    try {
      const { context, getWrittenResources } = testContext();
      await model.methods.collect_analytics.execute(
        {},
        context as unknown as ExecCtx,
      );
      const adoption = getWrittenResources().find((r) =>
        r.specName === "adoption"
      );
      const data = adoption?.data as {
        projects: number;
        skills: number;
        collected: boolean;
      };
      // both pages counted: p1 (projects), p2 (skills)
      assertEquals(data.projects, 1);
      assertEquals(data.skills, 1);
      assertEquals(data.collected, true);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: pagination terminates on a non-advancing cursor",
  sanitizeResources: false,
  fn: async () => {
    let userCalls = 0;
    const server = Deno.serve({ port: 0, onListen() {} }, (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/analytics/summaries")) {
        return Response.json({ summaries: MOCK_SUMMARIES });
      }
      if (path.endsWith("/analytics/users")) {
        userCalls++;
        // Always return the SAME cursor — a buggy/looping server.
        return Response.json({
          data: [{ user: { id: "x" } }],
          next_page: "STUCK",
        });
      }
      if (path.endsWith("/analytics/cost_report")) {
        return Response.json({ data: [], has_more: false, next_page: null });
      }
      return new Response("Not found", { status: 404 });
    });
    const addr = server.addr as Deno.NetAddr;
    const uninstall = installFetchMock(`http://localhost:${addr.port}`);
    try {
      const { context } = testContext();
      await model.methods.collect_analytics.execute(
        {},
        context as unknown as ExecCtx,
      );
      // Guard stops after the first repeat: page 1 + one repeat = 2 calls,
      // not an unbounded spin.
      assertEquals(userCalls <= 2, true);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// ---------------------------------------------------------------------------
// Error Handling Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "analytics: summaries API error throws with status",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer({
      failPath: "/analytics/summaries",
      failStatus: 403,
    });
    const uninstall = installFetchMock(url);
    try {
      const { context } = testContext();
      await assertRejects(
        () =>
          model.methods.collect_analytics.execute(
            {},
            context as unknown as ExecCtx,
          ),
        Error,
        "403",
      );
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// ---------------------------------------------------------------------------
// collect_user_usage
// ---------------------------------------------------------------------------

Deno.test("analytics model: has collect_user_usage method + userUsage resource", () => {
  assertExists(model.methods.collect_user_usage);
  assertExists(model.resources.userUsage);
  const shape = model.methods.collect_user_usage.arguments.shape;
  assertExists(shape.startDate);
  assertExists(shape.endDate);
  assertExists(shape.email);
  assertExists(shape.products);
});

// deno-lint-ignore no-explicit-any
type UserUsageData = any;

Deno.test({
  name:
    "analytics: collect_user_usage aggregates usage + cost per user by product",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      const result = await model.methods.collect_user_usage.execute(
        {},
        context as unknown as ExecCtx,
      );
      assertEquals(result.dataHandles.length, 1);
      const uu = getWrittenResources().find((r) => r.specName === "userUsage");
      assertExists(uu);
      assertEquals(uu.name, "all");
      const d = uu.data as UserUsageData;
      assertEquals(d.collected, true);
      assertEquals(d.error, null);
      assertEquals(d.count, 2);
      // Sorted by total cost desc → sescriva (422.80) before Bee (50.00).
      assertEquals(d.users[0].email, "sescriva@jw.org");
      const cc = d.users[0].byProduct.find((p: UserUsageData) =>
        p.product === "claude_code"
      );
      assertEquals(cc.totalTokens, 5000000);
      assertEquals(cc.costUsd, 412.8); // 41280 cents -> USD
      assertEquals(cc.requests, 120);
      assertEquals(d.users[0].totalCostUsd, 422.8); // 412.80 + 10.00 (chat)
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: collect_user_usage email filter keeps only that user",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      await model.methods.collect_user_usage.execute(
        { email: "sescriva@jw.org" },
        context as unknown as ExecCtx,
      );
      const uu = getWrittenResources().find((r) => r.specName === "userUsage");
      assertExists(uu);
      // A single filtered user is keyed by the unique userId (emails aren't
      // injective through sanitize), not the sanitized email.
      assertEquals(uu.name, "user-user_1");
      const d = uu.data as UserUsageData;
      assertEquals(d.filteredEmail, "sescriva@jw.org");
      assertEquals(d.count, 1);
      assertEquals(d.users[0].email, "sescriva@jw.org");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "analytics: collect_user_usage degrades (collected:false) when BOTH reports fail",
  sanitizeResources: false,
  fn: async () => {
    // Both per-user endpoints share the "/analytics/user_" prefix, so this
    // fails usage AND cost — the only case that yields collected:false.
    const { url, server } = startMockServer({
      failPath: "/analytics/user_",
      failStatus: 403,
    });
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      const result = await model.methods.collect_user_usage.execute(
        {},
        context as unknown as ExecCtx,
      );
      assertEquals(result.dataHandles.length, 1);
      const uu = getWrittenResources().find((r) => r.specName === "userUsage");
      assertExists(uu);
      const d = uu.data as UserUsageData;
      assertEquals(d.collected, false);
      assertExists(d.error);
      assertEquals(d.users.length, 0);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "analytics: collect_user_usage retains usage when only the cost report fails",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer({
      failPath: "/analytics/user_cost_report",
      failStatus: 403,
    });
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      await model.methods.collect_user_usage.execute(
        {},
        context as unknown as ExecCtx,
      );
      const uu = getWrittenResources().find((r) => r.specName === "userUsage");
      assertExists(uu);
      const d = uu.data as UserUsageData;
      // Usage succeeded → still collected, tokens retained; cost failed → cost
      // null + error noted. (The HIGH the review caught: don't discard usage.)
      assertEquals(d.collected, true);
      assertExists(d.error);
      assertEquals(d.count, 2);
      const u = d.users.find((x: UserUsageData) =>
        x.email === "sescriva@jw.org"
      );
      const cc = u.byProduct.find((p: UserUsageData) =>
        p.product === "claude_code"
      );
      assertEquals(cc.totalTokens, 5000000);
      assertEquals(cc.costUsd, null);
      assertEquals(u.totalCostUsd, 0);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name:
    "analytics: collect_user_usage email filter matching nobody writes empty collected result",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = testContext();
      await model.methods.collect_user_usage.execute(
        { email: "nobody@example.com" },
        context as unknown as ExecCtx,
      );
      const uu = getWrittenResources().find((r) => r.specName === "userUsage");
      assertExists(uu);
      const d = uu.data as UserUsageData;
      assertEquals(d.collected, true);
      assertEquals(d.count, 0);
      assertEquals(d.users.length, 0);
      assertEquals(d.filteredEmail, "nobody@example.com");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});
