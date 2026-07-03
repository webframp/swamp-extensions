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
// Mock Anthropic Analytics API Server
// ---------------------------------------------------------------------------

const MOCK_METRICS = [
  { name: "total_seats", value: 50, period: "current", breakdown: null },
  { name: "active_seats", value: 42, period: "current", breakdown: null },
  {
    name: "pending_invites",
    value: 3,
    period: "current",
    breakdown: null,
  },
  { name: "dau", value: 28, period: "2026-07-01", breakdown: null },
  { name: "wau", value: 35, period: "2026-W26", breakdown: null },
  { name: "mau", value: 40, period: "2026-06", breakdown: null },
  { name: "projects", value: 12, period: "current", breakdown: null },
  { name: "skills", value: 8, period: "current", breakdown: null },
  { name: "connectors", value: 4, period: "current", breakdown: null },
];

function startMockServer(
  overrides?: { metrics?: unknown[]; status?: number },
): { url: string; server: Deno.HttpServer } {
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    const url = new URL(req.url);
    if (overrides?.status) {
      return new Response(
        JSON.stringify({ error: { message: "Forbidden" } }),
        { status: overrides.status },
      );
    }
    if (url.pathname.startsWith("/v1/organizations/analytics")) {
      return Response.json({
        data: overrides?.metrics ?? MOCK_METRICS,
        data_refreshed_at: "2026-07-02T12:00:00Z",
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

// ---------------------------------------------------------------------------
// Method Execution Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "analytics: collect_analytics writes snapshot, seats, and adoption",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { analyticsKey: "ak-test-key" },
        definition: {
          id: "test-id",
          name: "test-analytics",
          version: 1,
          tags: {},
        },
      });
      const result = await model.methods.collect_analytics.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.collect_analytics.execute
        >[1],
      );
      assertEquals(result.dataHandles.length, 3);
      const resources = getWrittenResources();
      const specNames = resources.map((r) => r.specName).sort();
      assertEquals(specNames, ["adoption", "seats", "snapshot"]);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: snapshot contains all metrics with correct count",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { analyticsKey: "ak-test-key" },
        definition: {
          id: "test-id",
          name: "test-analytics",
          version: 1,
          tags: {},
        },
      });
      await model.methods.collect_analytics.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.collect_analytics.execute
        >[1],
      );
      const resources = getWrittenResources();
      const snapshot = resources.find((r) => r.specName === "snapshot");
      assertExists(snapshot);
      const data = snapshot.data as {
        metrics: { name: string; value: unknown }[];
        count: number;
        dataRefreshedAt: string;
      };
      assertEquals(data.count, 9);
      assertEquals(data.dataRefreshedAt, "2026-07-02T12:00:00Z");
      assertEquals(data.metrics[0].name, "total_seats");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: seats resource extracts correct values",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { analyticsKey: "ak-test-key" },
        definition: {
          id: "test-id",
          name: "test-analytics",
          version: 1,
          tags: {},
        },
      });
      await model.methods.collect_analytics.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.collect_analytics.execute
        >[1],
      );
      const resources = getWrittenResources();
      const seats = resources.find((r) => r.specName === "seats");
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
      assertEquals(data.total, 50);
      assertEquals(data.active, 42);
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
  name: "analytics: adoption resource extracts correct values",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer();
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { analyticsKey: "ak-test-key" },
        definition: {
          id: "test-id",
          name: "test-analytics",
          version: 1,
          tags: {},
        },
      });
      await model.methods.collect_analytics.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.collect_analytics.execute
        >[1],
      );
      const resources = getWrittenResources();
      const adoption = resources.find((r) => r.specName === "adoption");
      assertExists(adoption);
      assertEquals(adoption.name, "current");
      const data = adoption.data as {
        projects: number;
        skills: number;
        connectors: number;
      };
      assertEquals(data.projects, 12);
      assertEquals(data.skills, 8);
      assertEquals(data.connectors, 4);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: handles empty metrics response gracefully",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer({ metrics: [] });
    const uninstall = installFetchMock(url);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { analyticsKey: "ak-test-key" },
        definition: {
          id: "test-id",
          name: "test-analytics",
          version: 1,
          tags: {},
        },
      });
      await model.methods.collect_analytics.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.collect_analytics.execute
        >[1],
      );
      const resources = getWrittenResources();
      const snapshot = resources.find((r) => r.specName === "snapshot");
      assertExists(snapshot);
      const data = snapshot.data as { count: number };
      assertEquals(data.count, 0);

      const seats = resources.find((r) => r.specName === "seats");
      assertExists(seats);
      const seatsData = seats.data as { total: number | null };
      assertEquals(seatsData.total, null);
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

// ---------------------------------------------------------------------------
// Argument & Response Shape Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "analytics: collect_analytics passes date arguments to API",
  sanitizeResources: false,
  fn: async () => {
    const captured: Record<string, string> = {};
    const server = Deno.serve({ port: 0, onListen() {} }, (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/v1/organizations/analytics")) {
        for (const [k, v] of url.searchParams) captured[k] = v;
        return Response.json({
          data: MOCK_METRICS,
          data_refreshed_at: "2026-07-02T12:00:00Z",
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const addr = server.addr as Deno.NetAddr;
    const mockUrl = `http://localhost:${addr.port}`;
    const uninstall = installFetchMock(mockUrl);
    try {
      const { context } = createModelTestContext({
        globalArgs: { analyticsKey: "ak-test-key" },
        definition: {
          id: "test-id",
          name: "test-analytics",
          version: 1,
          tags: {},
        },
      });
      await model.methods.collect_analytics.execute(
        { startDate: "2026-06-01", endDate: "2026-07-01" },
        context as unknown as Parameters<
          typeof model.methods.collect_analytics.execute
        >[1],
      );
      assertEquals(captured["start_date"], "2026-06-01");
      assertEquals(captured["end_date"], "2026-07-01");
    } finally {
      uninstall();
      await server.shutdown();
    }
  },
});

Deno.test({
  name: "analytics: handles object-style metric response",
  sanitizeResources: false,
  fn: async () => {
    const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/v1/organizations/analytics")) {
        return Response.json({
          total_seats: 25,
          active_seats: 20,
          dau: 15,
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const addr = server.addr as Deno.NetAddr;
    const mockUrl = `http://localhost:${addr.port}`;
    const uninstall = installFetchMock(mockUrl);
    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { analyticsKey: "ak-test-key" },
        definition: {
          id: "test-id",
          name: "test-analytics",
          version: 1,
          tags: {},
        },
      });
      await model.methods.collect_analytics.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.collect_analytics.execute
        >[1],
      );
      const resources = getWrittenResources();
      const snapshot = resources.find((r) => r.specName === "snapshot");
      assertExists(snapshot);
      const data = snapshot.data as {
        metrics: { name: string; value: unknown }[];
        count: number;
      };
      assertEquals(data.count, 3);
      const names = data.metrics.map((m) => m.name).sort();
      assertEquals(names, ["active_seats", "dau", "total_seats"]);

      const seats = resources.find((r) => r.specName === "seats");
      assertExists(seats);
      const seatsData = seats.data as {
        total: number;
        active: number;
        dau: number;
      };
      assertEquals(seatsData.total, 25);
      assertEquals(seatsData.active, 20);
      assertEquals(seatsData.dau, 15);
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
  name: "analytics: API error throws with status and body",
  sanitizeResources: false,
  fn: async () => {
    const { url, server } = startMockServer({ status: 403 });
    const uninstall = installFetchMock(url);
    try {
      const { context } = createModelTestContext({
        globalArgs: { analyticsKey: "ak-bad-key" },
        definition: {
          id: "test-id",
          name: "test-analytics",
          version: 1,
          tags: {},
        },
      });
      await assertRejects(
        () =>
          model.methods.collect_analytics.execute(
            {},
            context as unknown as Parameters<
              typeof model.methods.collect_analytics.execute
            >[1],
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
